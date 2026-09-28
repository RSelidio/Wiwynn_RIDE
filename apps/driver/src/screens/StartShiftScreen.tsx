import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Route, Shuttle } from '@shuttle/shared-types';
import { colors, radius, space, TOUCH_TARGET, type as font } from '../lib/theme';

/**
 * Shift start (spec §2 — "Select assigned shuttle", "Start Shift").
 *
 * The driver picks the vehicle they are actually in. The backend refuses a
 * shuttle already signed out to someone else, so two drivers cannot both claim
 * one van — the error comes back here with the other driver's name.
 */
export function StartShiftScreen({
  driverName,
  shuttles,
  routes,
  onStart,
  onSignOut,
  busy,
  error,
}: {
  driverName: string;
  shuttles: Shuttle[];
  routes: Route[];
  onStart: (shuttleId: string, routeId: string | null) => void;
  onSignOut: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [shuttleId, setShuttleId] = React.useState<string | null>(null);
  const [routeId, setRouteId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (shuttleId == null && shuttles.length > 0) {
      const firstShuttle = shuttles[0]!;
      setShuttleId(firstShuttle.id);
      setRouteId(
        routes.some((route) => route.id === firstShuttle.defaultRouteId)
          ? firstShuttle.defaultRouteId
          : routes[0]?.id ?? null,
      );
    } else if (routeId == null && routes.length > 0) {
      setRouteId(routes[0]!.id);
    }
  }, [shuttles, routes, shuttleId, routeId]);

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.scroll}>
      <View style={styles.header}>
        <View style={styles.flexOne}>
          <Text style={styles.greeting}>Hello, {driverName}</Text>
          <Text style={styles.subtitle}>Select your shuttle to begin the shift</Text>
        </View>
        <TouchableOpacity onPress={onSignOut} accessibilityRole="button" style={styles.signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionLabel}>SHUTTLE</Text>
      {shuttles.length === 0 ? (
        <Text style={styles.empty}>No shuttles are in service. Contact the dispatcher.</Text>
      ) : (
        shuttles.map((shuttle) => {
          const selected = shuttle.id === shuttleId;
          return (
            <TouchableOpacity
              key={shuttle.id}
              onPress={() => {
                setShuttleId(shuttle.id);
                if (shuttle.defaultRouteId != null && routes.some((route) => route.id === shuttle.defaultRouteId)) {
                  setRouteId(shuttle.defaultRouteId);
                }
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <View style={styles.flexOne}>
                <Text style={styles.optionTitle}>{shuttle.name}</Text>
                <Text style={styles.optionMeta}>
                  {shuttle.plateNo} · {shuttle.model ?? 'Vehicle'} · {shuttle.capacity} seats
                  {shuttle.defaultRouteId != null ? ' · assigned default route' : ''}
                </Text>
              </View>
              <View style={[styles.radio, selected && styles.radioOn]} />
            </TouchableOpacity>
          );
        })
      )}

      {routes.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>ROUTE</Text>
          {routes.map((route) => {
            const selected = route.id === routeId;
            return (
              <TouchableOpacity
                key={route.id}
                onPress={() => setRouteId(route.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                style={[styles.option, selected && styles.optionSelected]}
              >
                <View style={styles.flexOne}>
                  <Text style={styles.optionTitle}>{route.name}</Text>
                  {route.description != null && (
                    <Text style={styles.optionMeta} numberOfLines={2}>
                      {route.description}
                    </Text>
                  )}
                </View>
                <View style={[styles.radio, selected && styles.radioOn]} />
              </TouchableOpacity>
            );
          })}
        </>
      )}

      {error != null && (
        <View style={styles.error} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <TouchableOpacity
        onPress={() => {
          if (shuttleId != null) onStart(shuttleId, routeId);
        }}
        disabled={shuttleId == null || busy}
        accessibilityRole="button"
        style={[styles.startButton, (shuttleId == null || busy) && styles.buttonDisabled]}
      >
        {busy ? <ActivityIndicator color="#001f30" /> : <Text style={styles.startText}>Start shift</Text>}
      </TouchableOpacity>

      <Text style={styles.hint}>
        Starting a shift turns on location sharing. It stops the moment you end the shift.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.page },
  flexOne: { flex: 1 },
  scroll: { padding: space.xl, paddingBottom: space.xxl },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: space.xl },
  greeting: { fontSize: font.heading, fontWeight: '700', color: colors.fg },
  subtitle: { fontSize: font.body, color: colors.fg3, marginTop: space.xs },
  signOut: { paddingVertical: space.sm, paddingHorizontal: space.md },
  signOutText: { color: colors.dangerText, fontSize: font.body, fontWeight: '500' },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    color: colors.fg3,
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: TOUCH_TARGET + 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.sm,
  },
  optionSelected: { borderColor: colors.accent, backgroundColor: colors.accentPale },
  optionTitle: { fontSize: 17, fontWeight: '600', color: colors.fg },
  optionMeta: { fontSize: font.label + 1, color: colors.fg3, marginTop: 2 },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  radioOn: { borderColor: colors.accent, backgroundColor: colors.accent, borderWidth: 8 },
  error: {
    backgroundColor: colors.dangerPale,
    borderRadius: radius.sm,
    padding: space.md,
    marginTop: space.lg,
  },
  errorText: { color: colors.dangerText, fontSize: font.body },
  startButton: {
    height: TOUCH_TARGET + 8,
    borderRadius: radius.md,
    backgroundColor: colors.go,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.xl,
  },
  buttonDisabled: { opacity: 0.45 },
  startText: { color: '#001f30', fontSize: 18, fontWeight: '700' },
  hint: {
    marginTop: space.md,
    fontSize: font.label,
    lineHeight: 18,
    color: colors.fg3,
    textAlign: 'center',
  },
  empty: { fontSize: font.body, color: colors.fg3, padding: space.md },
});
