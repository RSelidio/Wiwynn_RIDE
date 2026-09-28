/**
 * PM2 process definitions for the Windows cloud server (spec §15).
 *
 * Three Node processes sit behind IIS, which terminates HTTPS and reverse
 * proxies to them (spec §14). None of these ports is exposed publicly —
 * everything binds to loopback.
 *
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save                  persist the process list across reboots
 *   pm2 startup               install the Windows startup hook
 *
 * On Windows, `pm2 startup` is not supported directly; use pm2-windows-service
 * or a Scheduled Task running `pm2 resurrect` at boot. See
 * docs/deployment.md for the exact steps.
 */

module.exports = {
  apps: [
    {
      name: 'shuttle-backend',
      cwd: './apps/backend',
      script: './dist/server.js',
      // A single instance: the scheduler and the in-memory GPS store both
      // assume one process. See the note in src/jobs/scheduler.ts before
      // scaling this out.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      // A leak would otherwise take the API down slowly rather than visibly.
      max_memory_restart: '512M',
      kill_timeout: 12000,
      wait_ready: false,
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
        HOST: '127.0.0.1',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
        HOST: '127.0.0.1',
      },
      out_file: './logs/backend-out.log',
      error_file: './logs/backend-error.log',
      merge_logs: true,
      time: true,
    },

    {
      name: 'shuttle-employee',
      cwd: './apps/employee',
      // `output: 'standalone'` in next.config.mjs produces this entry point,
      // which bundles only the dependencies actually used.
      script: './.next/standalone/apps/employee/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        HOSTNAME: '127.0.0.1',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '127.0.0.1',
      },
      out_file: './logs/employee-out.log',
      error_file: './logs/employee-error.log',
      merge_logs: true,
      time: true,
    },

    {
      name: 'shuttle-admin',
      cwd: './apps/admin',
      script: './.next/standalone/apps/admin/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        PORT: 3001,
        HOSTNAME: '127.0.0.1',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOSTNAME: '127.0.0.1',
      },
      out_file: './logs/admin-out.log',
      error_file: './logs/admin-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
