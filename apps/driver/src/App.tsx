import React from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  PickupRequestView,
  Route,
  RouteWithStops,
  ServerToClientEvents,
  Shuttle,
} from '@shuttle/shared-types';
import { nextDriverAction } from '@shuttle/shared-utils';
import { config } from './lib/config';
import { driverApi, DriverApiError, getAccessToken, setSignedOutHandler, type DriverDashboard, type GpsFix } from './lib/api';
import * as gps from './lib/gps';
import { colors, space, type as font } from './lib/theme';
import { LoginScreen } from './screens/LoginScreen';
import { ShiftScreen } from './screens/ShiftScreen';
import { StartShiftScreen } from './screens/StartShiftScreen';

type Phase = 'restoring' | 'signed_out' | 'no_shift' | 'on_shift';

/**
 * Driver app root.
 *
 * Three states, no navigator: signed out, on shift, or not. A driver in a
 * moving vehicle should never have to find a screen, so there is nowhere to
 * navigate to.
 */
export function App() {
  const [phase, setPhase] = React.useState<Phase>('restoring');
  const [driverName, setDriverName] = React.useState('');
  const [dashboard, setDashboard] = React.useState<DriverDashboard | null>(null);
  const [shuttles, setShuttles] = React.useState<Shuttle[]>([]);
  const [routes, setRoutes] = React.useState<Route[]>([]);
  const [routeDetails, setRouteDetails] = React.useState<RouteWithStops[]>([]);

  const [lastFix, setLastFix] = React.useState<GpsFix | null>(null);
  const [queuedFixes, setQueuedFixes] = React.useState(0);
  const [gpsUploadState, setGpsUploadState] = React.useState<{
    uploading: boolean;
    error: string | null;
    lastSentAt: string | null;
  }>({ uploading: false, error: null, lastSentAt: null });
  const [backgroundGranted, setBackgroundGranted] = React.useState(true);

  const [busy, setBusy] = React.useState(false);
  const [busyRequestId, setBusyRequestId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const socketRef = React.useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const trackingShiftRef = React.useRef<string | null>(null);

  const message = (err: unknown, fallback: string): string =>
    err instanceof DriverApiError ? err.message : fallback;

  // ── Dashboard ──────────────────────────────────────────────────────────

  const loadDashboard = React.useCallback(async (): Promise<DriverDashboard | null> => {
    try {
      const data = await driverApi.dashboard();
      setDashboard(data);
      setPhase(data.shift == null ? 'no_shift' : 'on_shift');
      return data;
    } catch (err) {
      setError(message(err, 'Could not reach the server.'));
      return null;
    }
  }, []);

  const loadPickers = React.useCallback(async () => {
    try {
      const [shuttleList, routeList, detailedRoutes] = await Promise.all([
        driverApi.shuttles(),
        driverApi.routes(),
        driverApi.routeDetails(),
      ]);
      setShuttles(shuttleList);
      setRoutes(routeList);
      setRouteDetails(detailedRoutes);
    } catch {
      // The start screen shows an empty list with an explanation.
    }
  }, []);

  const resumeGpsForShift = React.useCallback(async (shiftId: string, intervalSec: number) => {
    if (trackingShiftRef.current === shiftId) return;
    const permission = await gps.requestPermissions();
    if (!permission.granted) {
      setError(permission.message ?? 'Location permission is required to report shuttle GPS.');
      return;
    }
    setBackgroundGranted(permission.background);
    if (permission.message != null) setError(permission.message);
    await gps.startTracking(shiftId, intervalSec);
    trackingShiftRef.current = shiftId;
    await gps.pushOnce(shiftId);
  }, []);

  // ── Session restore ────────────────────────────────────────────────────

  React.useEffect(() => {
    setSignedOutHandler(() => {
      setPhase('signed_out');
      setDashboard(null);
      trackingShiftRef.current = null;
      void gps.stopTracking();
    });

    void (async () => {
      try {
        const session = await driverApi.restore();
        if (session == null) {
          setPhase('signed_out');
          return;
        }
        setDriverName(session.driver?.displayName ?? session.user.displayName);
        await loadPickers();
        const data = await loadDashboard();
        // The backend keeps an open shift across JS reloads, but a foreground
        // location watcher does not. Restore GPS whenever that shift is resumed.
        if (data?.shift != null) {
          await resumeGpsForShift(data.shift.shiftId, data.gpsPushIntervalSec ?? config.defaultGpsIntervalSec);
        }
      } catch (err) {
        setError(message(err, 'Could not restore the driver session.'));
        setPhase('signed_out');
      }
    })();

    return () => setSignedOutHandler(null);
  }, [loadDashboard, loadPickers, resumeGpsForShift]);

  // ── GPS fix subscription ───────────────────────────────────────────────

  React.useEffect(
    () =>
      gps.onFix((fix, queued) => {
        setLastFix(fix);
        setQueuedFixes(queued);
      }),
    [],
  );

  React.useEffect(() => gps.onUploadState(setGpsUploadState), []);

  // ── Realtime ───────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (phase !== 'on_shift' && phase !== 'no_shift') return;

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(config.socketUrl, {
      auth: (cb) => cb({ token: getAccessToken() ?? '' }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2_000,
    });

    // A new offer or any change to our own work reloads the dashboard. The
    // payload could be merged instead, but a reload is one request and cannot
    // drift from the server's view of the queue.
    socket.on('request:offered', () => void loadDashboard());
    socket.on('request:changed', () => void loadDashboard());

    socketRef.current = socket;

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [phase, loadDashboard]);

  // Keep the tablet awake while a shift is running: it is usually docked and
  // charging, and a locked screen is one more thing between the driver and
  // accepting a request.
  React.useEffect(() => {
    if (phase !== 'on_shift' || Platform.OS === 'web') return;
    void activateKeepAwakeAsync();
    // The cleanup must return void, not the promise deactivate hands back.
    return () => {
      void deactivateKeepAwake();
    };
  }, [phase]);

  // ── Actions ────────────────────────────────────────────────────────────

  const signIn = async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const session = await driverApi.login(email, password);
      if (session.driver == null) {
        setError('This account is not registered as a driver.');
        await driverApi.logout();
        return;
      }
      setDriverName(session.driver.displayName);
      await loadPickers();
      const data = await loadDashboard();
      if (data?.shift != null) {
        await resumeGpsForShift(data.shift.shiftId, data.gpsPushIntervalSec ?? config.defaultGpsIntervalSec);
      }
    } catch (err) {
      setError(message(err, 'Could not sign in.'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await gps.stopTracking();
    trackingShiftRef.current = null;
    await driverApi.logout();
    setPhase('signed_out');
    setDashboard(null);
    setLastFix(null);
  };

  const startShift = async (shuttleId: string, routeId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      // Permission first: starting a shift that cannot report position would
      // show waiting employees a shuttle that never moves.
      const permission = await gps.requestPermissions();
      if (!permission.granted) {
        setError(permission.message ?? 'Location permission is required.');
        return;
      }
      setBackgroundGranted(permission.background);
      if (permission.message != null) setError(permission.message);

      const shift = await driverApi.startShift(shuttleId, routeId);
      const data = await loadDashboard();

      const interval = data?.gpsPushIntervalSec ?? config.defaultGpsIntervalSec;
      await gps.startTracking(shift.id, interval);
      trackingShiftRef.current = shift.id;
      await gps.pushOnce(shift.id);
    } catch (err) {
      setError(message(err, 'Could not start the shift.'));
    } finally {
      setBusy(false);
    }
  };

  const finishEndShift = async (shiftId: string) => {
    setBusy(true);
    try {
      await gps.flush();
      await driverApi.endShift(shiftId);
      await gps.stopTracking();
      trackingShiftRef.current = null;
      setLastFix(null);
      setQueuedFixes(0);
      await loadDashboard();
    } catch (err) {
      setError(message(err, 'Could not end the shift.'));
    } finally {
      setBusy(false);
    }
  };

  const endShift = () => {
    const currentDashboard = dashboard;
    if (currentDashboard == null) return;
    const shift = currentDashboard.shift;
    if (shift == null) return;

    const onboardCount = currentDashboard.onboardCount;
    if (onboardCount > 0) {
      setError(`${onboardCount} passenger${onboardCount === 1 ? ' is' : 's are'} still recorded onboard. Scan OUT or use Clear all as OUT before ending the shift.`);
      return;
    }

    const open = dashboard?.queue.length ?? 0;
    const confirmation = open > 0
      ? `You still have ${open} pickup${open === 1 ? '' : 's'} in your queue. They will go back to the dispatcher.`
      : 'Location sharing will stop and the shuttle will be released.';

    if (Platform.OS === 'web') {
      if (window.confirm(`End shift?\n\n${confirmation}`)) void finishEndShift(shift.shiftId);
      return;
    }

    Alert.alert(
      'End shift?',
      confirmation,
      [
        { text: 'Keep driving', style: 'cancel' },
        {
          text: 'End shift',
          style: 'destructive',
          onPress: () => { void finishEndShift(shift.shiftId); },
        },
      ],
    );
  };

  const toggleOnline = async (online: boolean) => {
    const current = dashboard;
    const shift = current?.shift;
    if (current == null || shift == null) return;

    // Optimistic: the switch should not lag behind the driver's thumb.
    setDashboard({ ...current, shift: { ...shift, isOnline: online } });

    try {
      await driverApi.setOnline(shift.shiftId, online);
      await loadDashboard();
    } catch (err) {
      setError(message(err, 'Could not change your availability.'));
      await loadDashboard();
    }
  };

  const runRequestAction = async (id: string, action: () => Promise<unknown>) => {
    setBusyRequestId(id);
    setError(null);
    try {
      await action();
      await loadDashboard();
    } catch (err) {
      setError(message(err, 'That action failed.'));
      await loadDashboard();
    } finally {
      setBusyRequestId(null);
    }
  };

  const advance = (request: PickupRequestView) => {
    const action = nextDriverAction(request.status);
    if (action == null) return;

    void runRequestAction(request.id, () => {
      switch (action.to) {
        case 'arrived':
          return driverApi.arrived(request.id);
        case 'boarding':
          return driverApi.board(request.id);
        case 'completed':
          return driverApi.complete(request.id);
        default:
          return Promise.resolve();
      }
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────

  let screen: React.ReactNode;

  if (phase === 'restoring') {
    screen = (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.loadingText}>Signing you in…</Text>
      </View>
    );
  } else if (phase === 'signed_out') {
    screen = <LoginScreen onSubmit={(email, password) => void signIn(email, password)} error={error} busy={busy} />;
  } else if (phase === 'no_shift' || dashboard?.shift == null) {
    screen = (
      <StartShiftScreen
        driverName={driverName}
        shuttles={shuttles}
        routes={routes}
        onStart={(shuttleId, routeId) => void startShift(shuttleId, routeId)}
        onSignOut={() => void signOut()}
        busy={busy}
        error={error}
      />
    );
  } else {
    screen = (
      <ShiftScreen
        dashboard={dashboard}
        route={routeDetails.find((route) => route.id === dashboard.shift?.routeId) ?? null}
        lastFix={lastFix}
        queuedFixes={queuedFixes}
        gpsUploadState={gpsUploadState}
        backgroundGranted={backgroundGranted}
        backgroundTrackingSupported={gps.backgroundTrackingSupported}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          void loadDashboard().finally(() => setRefreshing(false));
        }}
        onToggleOnline={(online) => void toggleOnline(online)}
        onEndShift={endShift}
        onAccept={(id) => void runRequestAction(id, () => driverApi.accept(id))}
        onReject={(id) => void runRequestAction(id, () => driverApi.reject(id, 'Declined by driver'))}
        onAdvance={advance}
        onScanBadge={async (rfidTag) => {
          const result = await driverApi.scanPassengerBadge(dashboard.shift!.shiftId, rfidTag);
          setDashboard((current) => current == null ? current : { ...current, onboardCount: result.onboardCount });
          await loadDashboard();
          return result;
        }}
        onClearOnboard={async () => {
          const result = await driverApi.clearOnboardPassengers(dashboard.shift!.shiftId);
          await loadDashboard();
          return result.clearedCount;
        }}
        busyRequestId={busyRequestId}
        error={error}
      />
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        {screen}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.page },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  loadingText: { fontSize: font.body, color: colors.fg3 },
});
