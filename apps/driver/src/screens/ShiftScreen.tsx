import React from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
  import {
    Alert,
    Platform,
  } from 'react-native';
import type { PickupRequestView, RouteWithStops, ScanPassengerBadgeResult } from '@shuttle/shared-types';
import { formatTime, humanizeEtaSec, nextDriverAction } from '@shuttle/shared-utils';
import type { DriverDashboard, GpsFix } from '../lib/api';
import { colors, radius, space, TOUCH_TARGET, type as font } from '../lib/theme';

/**
 * The working screen (spec §2).
 *
 * Everything a driver needs while moving, in one scroll: shift state, GPS and
 * server health, the next stop, incoming offers, and the queue with one clear
 * action per row. No navigation — a driver should never have to find a screen.
 */
export function ShiftScreen({
  dashboard,
  route,
  lastFix,
  queuedFixes,
  gpsUploadState,
  backgroundGranted,
  backgroundTrackingSupported,
  onRefresh,
  onToggleOnline,
  onEndShift,
  onAccept,
  onReject,
  onAdvance,
  onScanBadge,
    onClearOnboard,
  busyRequestId,
  error,
  refreshing,
}: {
  dashboard: DriverDashboard;
  route: RouteWithStops | null;
  lastFix: GpsFix | null;
  queuedFixes: number;
  gpsUploadState: { uploading: boolean; error: string | null; lastSentAt: string | null };
  backgroundGranted: boolean;
  backgroundTrackingSupported: boolean;
  onRefresh: () => void;
  onToggleOnline: (online: boolean) => void;
  onEndShift: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAdvance: (request: PickupRequestView) => void;
  onScanBadge: (rfidTag: string) => Promise<ScanPassengerBadgeResult>;
    onClearOnboard: () => Promise<number>;
  busyRequestId: string | null;
  error: string | null;
  refreshing: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const wideLayout = width >= 850 && width > height;
  const { shift, status, etaBoard, queue, offers } = dashboard;
  const nextEstimate = etaBoard?.estimates[0];
  const [rfidTag, setRfidTag] = React.useState('');
  const [scanning, setScanning] = React.useState(false);
  const [scanMessage, setScanMessage] = React.useState<string | null>(null);
  const [onboardCount, setOnboardCount] = React.useState(dashboard.onboardCount);
  const [clearingOnboard, setClearingOnboard] = React.useState(false);
  const [rosterMessage, setRosterMessage] = React.useState<string | null>(null);
  const capacity = shift?.capacity ?? 0;

  React.useEffect(() => setOnboardCount(dashboard.onboardCount), [dashboard.onboardCount]);

  const submitRfid = async () => {
    const tag = rfidTag.trim();
    if (!tag || scanning) return;
    setScanning(true);
    setScanMessage(null);
    try {
      const result = await onScanBadge(tag);
      setOnboardCount(result.onboardCount);
      setScanMessage(`${result.employeeName} · ${result.action === 'in' ? 'IN — boarded' : 'OUT — alighted'} · ${result.onboardCount}/${result.capacity} inside`);
      setRfidTag('');
    } catch (scanError) {
      setScanMessage(scanError instanceof Error ? scanError.message : 'Badge scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const clearRoster = () => {
    if (onboardCount === 0 || clearingOnboard) return;
    const confirmClear = async () => {
      setClearingOnboard(true);
      setRosterMessage(null);
      try {
        const cleared = await onClearOnboard();
        setOnboardCount(0);
        setRosterMessage(`${cleared} passenger${cleared === 1 ? '' : 's'} recorded OUT manually.`);
      } catch (clearError) {
        setRosterMessage(clearError instanceof Error ? clearError.message : 'Could not clear onboard list.');
      } finally {
        setClearingOnboard(false);
      }
    };

    const message = `Record all ${onboardCount} passenger${onboardCount === 1 ? '' : 's'} as manually OUT? This keeps the history and updates the onboard count.`;
    if (Platform.OS === 'web') {
      if (window.confirm(message)) void confirmClear();
    } else {
      Alert.alert('Clear onboard list?', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Record all OUT', style: 'destructive', onPress: () => { void confirmClear(); } },
      ]);
    }
  };

  const fixAgeSec =
    lastFix == null ? null : Math.round((Date.now() - Date.parse(lastFix.recordedAt)) / 1000);
  const gpsHealthy = fixAgeSec != null && fixAgeSec < 30;
  const atStopId = status?.atStopId ?? null;
  const routeLegs = route?.stops.slice().sort((a, b) => a.stopOrder - b.stopOrder) ?? [];
  const etaByStop = new Map((etaBoard?.estimates ?? []).map((estimate) => [estimate.stopId, estimate]));
  const nextStopId = etaBoard?.estimates[0]?.stopId ?? status?.nextStopId ?? null;
  const waitingAtCurrentStop = atStopId == null
    ? []
    : queue.filter((request) => request.pickupStopId === atStopId && request.status !== 'boarding');

  if (shift == null) return null;

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.scroll, wideLayout && styles.wideScroll]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* ── Shift header ──────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.flexOne}>
          <View style={styles.brandRow}>
            <Text style={styles.shuttleName}>Shuttle Driver</Text>
            <Text style={styles.vehicleBadge}>{shift.shuttleCode}</Text>
            <Text style={styles.shiftBadge}>● On shift · {formatTime(shift.startedAt)}</Text>
          </View>
          <Text style={styles.shiftMeta}>
            {shift.shuttleName} · {shift.driverName}
          </Text>
        </View>

        <View style={styles.onlineToggle}>
          <Text style={[styles.onlineLabel, shift.isOnline && styles.onlineLabelOn]}>
            {shift.isOnline ? 'Online' : 'Offline'}
          </Text>
          <Switch
            value={shift.isOnline}
            onValueChange={onToggleOnline}
            trackColor={{ true: colors.go, false: colors.borderStrong }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <View style={wideLayout ? styles.wideColumns : undefined}>
      <View style={wideLayout ? styles.leftColumn : undefined}>
      {/* ── Health strip ──────────────────────────────────────────────── */}
      <View style={styles.healthRow}>
        <Health
          label="GPS"
          value={fixAgeSec == null ? 'waiting' : `${fixAgeSec}s ago`}
          tone={gpsHealthy ? 'ok' : 'warn'}
        />
        <Health
          label="Accuracy"
          value={lastFix?.accuracyM == null ? '—' : `±${Math.round(lastFix.accuracyM)}m`}
          tone="neutral"
        />
        <Health
          label="GPS sync"
          value={gpsUploadState.error != null
            ? 'error'
            : gpsUploadState.uploading
              ? 'sending…'
              : gpsUploadState.lastSentAt == null
                ? 'waiting'
                : `${Math.max(0, Math.round((Date.now() - Date.parse(gpsUploadState.lastSentAt)) / 1000))}s ago`}
          tone={gpsUploadState.error != null ? 'warn' : gpsUploadState.lastSentAt != null ? 'ok' : 'neutral'}
        />
        <Health
          label="Speed"
          value={lastFix?.speedKmh == null ? '—' : `${Math.round(lastFix.speedKmh)} km/h`}
          tone="neutral"
        />
      </View>

      {!backgroundGranted && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            {backgroundTrackingSupported
              ? 'Background location is off, so tracking stops when the screen locks. Set location access to “Allow all the time” in Settings.'
              : 'Expo Go only tracks while the app is open. Keep this screen visible during the test; a development build is needed for background tracking.'}
          </Text>
        </View>
      )}

      {gpsUploadState.error != null && (
        <View style={styles.error} accessibilityRole="alert">
          <Text style={styles.errorText}>GPS is being read, but the server did not accept the update: {gpsUploadState.error}</Text>
        </View>
      )}

      {error != null && (
        <View style={styles.error} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* ── Next stop and load ────────────────────────────────────────── */}
      <View style={styles.statRow}>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>NEXT STOP</Text>
          <Text style={styles.statValue} numberOfLines={1}>
            {status?.atStopName ?? status?.nextStopName ?? '—'}
          </Text>
          <Text style={styles.statMeta}>
            {status?.atStopId != null ? 'At the stop' : humanizeEtaSec(nextEstimate?.etaSec ?? null)}
          </Text>
        </View>

        <View style={styles.statCard}>
          <Text style={styles.statLabel}>PASSENGERS</Text>
          <Text style={styles.statValue}>
            {onboardCount}
            <Text style={styles.statValueMuted}> / {capacity}</Text>
          </Text>
          <View style={styles.seatBar}>
            {Array.from({ length: capacity }, (_, index) => (
              <View key={index} style={[styles.seatCell, index < onboardCount && styles.seatCellFilled]} />
            ))}
          </View>
        </View>
      </View>

      {/* ── RFID passenger in/out ────────────────────────────────────── */}
      <View style={styles.rfidCard}>
        <View style={styles.rfidHeader}>
          <View style={styles.flexOne}>
            <Text style={styles.rfidTitle}>RFID · passenger in / out</Text>
            <Text style={styles.rfidHint}>Tap a badge once to board, tap it again when the passenger leaves.</Text>
          </View>
          <Text style={styles.rfidCount}>{onboardCount}/{capacity}</Text>
        </View>
        <View style={styles.rfidControls}>
          <TextInput
            value={rfidTag}
            onChangeText={setRfidTag}
            onSubmitEditing={() => void submitRfid()}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            blurOnSubmit={false}
            returnKeyType="done"
            placeholder="Tap badge or enter RFID UID"
            placeholderTextColor={colors.fg3}
            editable={!scanning}
            style={styles.rfidInput}
            accessibilityLabel="RFID badge scanner input"
          />
          <TouchableOpacity onPress={() => void submitRfid()} disabled={!rfidTag.trim() || scanning} style={[styles.rfidButton, (!rfidTag.trim() || scanning) && styles.buttonDisabled]} accessibilityRole="button">
            {scanning ? <ActivityIndicator color="#fff" /> : <Text style={styles.rfidButtonText}>Scan</Text>}
          </TouchableOpacity>
        </View>
        {scanMessage != null && <Text accessibilityRole="alert" style={styles.rfidFeedback}>{scanMessage}</Text>}
      </View>

      {/* ── Route progress and GPS-confirmed stop state ──────────────── */}
      <View style={styles.routeCard}>
        <View style={styles.routeHead}>
          <View style={styles.flexOne}>
            <Text style={styles.routeTitle}>Route · {route?.name ?? shift.routeName ?? 'Unassigned'}</Text>
            <Text style={styles.routeSubtitle}>
              {atStopId != null
                ? `GPS confirms arrival · ${status?.atStopName ?? 'Stop'}`
                : status?.nextStopName != null
                  ? `En route to ${status.nextStopName}`
                  : 'Waiting for route GPS'}
            </Text>
          </View>
          {nextEstimate?.distanceM != null && (
            <Text style={styles.routeMeta}>{(nextEstimate.distanceM / 1000).toFixed(1)} km · {humanizeEtaSec(nextEstimate.etaSec)}</Text>
          )}
        </View>
        {routeLegs.length > 0 ? (
          <View style={[styles.routeStops, wideLayout && styles.routeStopsWide]}>
            {routeLegs.map((leg, index) => {
              const isHere = leg.stopId === atStopId;
              const isNext = leg.stopId === nextStopId && !isHere;
              const eta = etaByStop.get(leg.stopId);
              return (
                <View key={leg.id} style={[styles.routeStop, wideLayout && styles.routeStopWide]}>
                  <View style={[styles.routeDot, isHere && styles.routeDotHere, isNext && styles.routeDotNext]}>
                    <Text style={[styles.routeDotText, (isHere || isNext) && styles.routeDotTextActive]}>{index + 1}</Text>
                  </View>
                  <View style={styles.flexOne}>
                    <Text style={[styles.routeStopName, (isHere || isNext) && styles.routeStopNameActive]}>{leg.stop.name}</Text>
                    <Text style={styles.routeStopMeta}>
                      {isHere ? 'At stop · pickups can board' : isNext ? `Next · ${humanizeEtaSec(eta?.etaSec ?? null)}` : eta ? humanizeEtaSec(eta.etaSec) : 'On route'}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={styles.emptyText}>No stops are configured on this route yet.</Text>
        )}
        {atStopId != null && (
          <View style={styles.stopArrivalBanner}>
            <Text style={styles.stopArrivalTitle}>At {status?.atStopName ?? 'stop'}</Text>
            <Text style={styles.stopArrivalText}>
              {waitingAtCurrentStop.length > 0
                ? `${waitingAtCurrentStop.length} accepted pickup${waitingAtCurrentStop.length === 1 ? '' : 's'} waiting here. Review and board these passengers before continuing.`
                : 'No accepted pickups waiting at this stop. Route progress follows the shuttle GPS as it continues.'}
            </Text>
          </View>
        )}
      </View>

      </View>

      <View style={wideLayout ? styles.rightColumn : undefined}>

      {/* ── Incoming offers ──────────────────────────────────────────── */}
      {offers.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>NEW PICKUP {offers.length > 1 ? 'REQUESTS' : 'REQUEST'}</Text>
          {offers.map((offer) => (
            <View key={offer.id} style={styles.offerCard}>
              <View style={styles.offerHead}>
                <Text style={styles.pill}>New request</Text>
                <Text style={styles.offerCode}>{offer.code}</Text>
              </View>

              <Text style={styles.offerStop}>{offer.pickupStopName}</Text>
              <Text style={styles.offerMeta}>
                Destination: {offer.destinationStopName} ·{' '}
                {offer.passengerCount === 1 ? '1 passenger' : `${offer.passengerCount} passengers`}
              </Text>
              <Text style={styles.offerWho}>
                {offer.employeeName}
                {offer.employeeDepartment != null && ` · ${offer.employeeDepartment}`}
              </Text>

              <View style={styles.offerActions}>
                <TouchableOpacity
                  onPress={() => onAccept(offer.id)}
                  disabled={busyRequestId != null}
                  accessibilityRole="button"
                  style={[styles.acceptButton, busyRequestId != null && styles.buttonDisabled]}
                >
                  {busyRequestId === offer.id ? (
                    <ActivityIndicator color="#001f30" />
                  ) : (
                    <Text style={styles.acceptText}>Accept</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => onReject(offer.id)}
                  disabled={busyRequestId != null}
                  accessibilityRole="button"
                  style={[styles.rejectButton, busyRequestId != null && styles.buttonDisabled]}
                >
                  <Text style={styles.rejectText}>Reject</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </>
      )}

      {/* ── Queue ────────────────────────────────────────────────────── */}
      <Text style={styles.sectionLabel}>PICKUP QUEUE · {queue.length}</Text>

      {queue.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            Nothing assigned. New requests appear above as employees send them.
          </Text>
        </View>
      ) : (
        queue.map((request) => {
          const action = nextDriverAction(request.status);
          const isBusy = busyRequestId === request.id;
          const atRequestStop = request.status !== 'accepted' || atStopId === request.pickupStopId;

          return (
            <View key={request.id} style={styles.queueCard}>
              <View style={styles.queueHead}>
                <View style={styles.flexOne}>
                  <Text style={styles.queueName}>{request.employeeName}</Text>
                  <Text style={styles.queueRoute}>
                    Pickup: {request.pickupStopName} · Destination: {request.destinationStopName}
                  </Text>
                </View>
                <View style={styles.queueRight}>
                  <Text style={styles.queueCode}>{request.code}</Text>
                  <Text style={styles.queuePax}>
                    {request.passengerCount} pax
                  </Text>
                </View>
              </View>

              {action != null && (
                <TouchableOpacity
                  onPress={() => onAdvance(request)}
                  disabled={busyRequestId != null || !atRequestStop}
                  accessibilityRole="button"
                  style={[
                    styles.advanceButton,
                    request.status === 'boarding' && styles.advanceButtonFinal,
                    (busyRequestId != null || !atRequestStop) && styles.buttonDisabled,
                  ]}
                >
                  {isBusy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.advanceText}>{request.status === 'accepted' && !atRequestStop ? `Arrive at ${request.pickupStopName} to confirm` : action.label}</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          );
        })
      )}

      {/* ── End shift ────────────────────────────────────────────────── */}
      <TouchableOpacity onPress={onEndShift} accessibilityRole="button" style={styles.endShift}>
        <Text style={styles.endShiftText}>End shift</Text>
      </TouchableOpacity>

      <View style={styles.onboardRoster}>
        <View style={styles.onboardRosterHeader}>
          <View style={styles.flexOne}>
            <Text style={styles.onboardRosterTitle}>Currently IN · {dashboard.onboardPassengers.length}</Text>
            <Text style={styles.onboardRosterHint}>People recorded onboard this shift.</Text>
          </View>
          {dashboard.onboardPassengers.length > 0 && (
            <TouchableOpacity
              onPress={clearRoster}
              disabled={clearingOnboard}
              accessibilityRole="button"
              style={[styles.clearRosterButton, clearingOnboard && styles.buttonDisabled]}
            >
              {clearingOnboard ? <ActivityIndicator color={colors.dangerText} /> : <Text style={styles.clearRosterText}>Clear all as OUT</Text>}
            </TouchableOpacity>
          )}
        </View>
        {rosterMessage != null && <Text accessibilityRole="alert" style={styles.rfidFeedback}>{rosterMessage}</Text>}
        <ScrollView
          style={styles.onboardRosterScroll}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {dashboard.onboardPassengers.length === 0 ? (
            <Text style={styles.emptyText}>No passengers currently recorded IN.</Text>
          ) : dashboard.onboardPassengers.map((passenger) => (
            <View key={passenger.boardingId} style={styles.onboardPassengerRow}>
              <View style={styles.passengerInitial}><Text style={styles.passengerInitialText}>{passenger.displayName.trim().slice(0, 1).toUpperCase()}</Text></View>
              <View style={styles.flexOne}>
                <Text style={styles.onboardPassengerName}>{passenger.displayName}</Text>
                <Text style={styles.onboardPassengerMeta}>Badge {passenger.badgeNo} · IN {formatTime(passenger.boardedAt)}</Text>
              </View>
              <Text style={styles.passengerInTag}>IN</Text>
            </View>
          ))}
        </ScrollView>
      </View>

      <Text style={styles.footNote}>
        Ending the shift stops location sharing and releases {shift.shuttleName} for the next driver.
      </Text>
      </View>
      </View>
    </ScrollView>
  );
}

function Health({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'neutral';
}) {
  const dotColour =
    tone === 'ok' ? colors.go : tone === 'warn' ? colors.warn : colors.borderStrong;

  return (
    <View style={styles.health}>
      <View style={styles.healthTop}>
        <View style={[styles.healthDot, { backgroundColor: dotColour }]} />
        <Text style={styles.healthLabel}>{label}</Text>
      </View>
      <Text style={styles.healthValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.page },
  flexOne: { flex: 1 },
  scroll: { padding: space.lg, paddingBottom: space.xxl },
  wideScroll: { flexGrow: 1 },
  wideColumns: { flex: 1, minHeight: 0, flexDirection: 'row', alignItems: 'stretch', gap: space.lg },
  leftColumn: { flex: 1.35, minWidth: 0 },
  rightColumn: { flex: 1, minWidth: 340 },

  header: { flexDirection: 'row', alignItems: 'center', marginBottom: space.lg },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  shuttleName: { fontSize: font.heading, fontWeight: '700', color: colors.fg },
  vehicleBadge: { overflow: 'hidden', color: colors.accentDeep, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, fontSize: 10, fontWeight: '600' },
  shiftBadge: { overflow: 'hidden', color: colors.fg2, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 5, paddingHorizontal: 9, paddingVertical: 5, fontSize: font.label },
  shiftMeta: { fontSize: font.label + 1, color: colors.fg3, marginTop: 2 },
  onlineToggle: { alignItems: 'center', gap: space.xs },
  onlineLabel: { fontSize: font.label, fontWeight: '600', color: colors.fg3 },
  onlineLabelOn: { color: colors.goText },

  healthRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  health: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.sm,
  },
  healthTop: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  healthDot: { width: 7, height: 7, borderRadius: 4 },
  healthLabel: { fontSize: 10, fontWeight: '600', color: colors.fg3, letterSpacing: 0.5 },
  healthValue: { fontSize: font.label + 1, color: colors.fg, marginTop: 3, fontVariant: ['tabular-nums'] },

  notice: {
    backgroundColor: colors.warnPale,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.md,
  },
  noticeText: { color: colors.warnText, fontSize: font.label + 1, lineHeight: 18 },

  error: { backgroundColor: colors.dangerPale, borderRadius: radius.sm, padding: space.md, marginBottom: space.md },
  errorText: { color: colors.dangerText, fontSize: font.body },

  statRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.lg,
  },
  statLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 1, color: colors.fg3 },
  statValue: {
    fontSize: font.display,
    fontWeight: '600',
    color: colors.accentDeep,
    marginTop: space.xs,
    fontVariant: ['tabular-nums'],
  },
  statValueMuted: { fontSize: font.body, color: colors.fg3, fontWeight: '500' },
  statMeta: { fontSize: font.label + 1, color: colors.fg3, marginTop: space.xs },
  rfidCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space.lg, marginBottom: space.lg },
  rfidHeader: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rfidTitle: { fontSize: font.body, color: colors.fg, fontWeight: '700' },
  rfidHint: { marginTop: 3, color: colors.fg3, fontSize: font.label, lineHeight: 17 },
  rfidCount: { color: colors.accentDeep, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rfidControls: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  rfidInput: { flex: 1, minWidth: 0, height: TOUCH_TARGET, backgroundColor: colors.page, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: space.md, color: colors.fg, fontSize: font.body },
  rfidButton: { minWidth: 82, height: TOUCH_TARGET, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  rfidButtonText: { color: '#fff', fontSize: font.body, fontWeight: '700' },
  rfidFeedback: { marginTop: space.sm, color: colors.fg2, fontSize: font.label + 1 },

  routeCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.lg,
  },
  routeHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },
  routeTitle: { fontSize: 17, fontWeight: '700', color: colors.fg },
  routeSubtitle: { fontSize: font.label + 1, color: colors.fg3, marginTop: 3 },
  routeMeta: { fontSize: font.label, color: colors.fg3, fontVariant: ['tabular-nums'] },
  routeStops: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  routeStopsWide: { flexWrap: 'nowrap', alignItems: 'flex-start', gap: 0 },
  routeStop: {
    flexGrow: 1,
    flexBasis: 135,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    borderTopWidth: 2,
    borderTopColor: colors.border,
  },
  routeStopWide: { flexBasis: 0, minWidth: 0, paddingHorizontal: space.xs, borderTopWidth: 2, borderTopColor: colors.accent },
  routeDot: { width: 25, height: 25, borderRadius: 13, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  routeDotHere: { backgroundColor: colors.accent, borderColor: colors.accent },
  routeDotNext: { borderColor: colors.accent, backgroundColor: colors.accentPale },
  routeDotText: { color: colors.fg3, fontSize: 11, fontWeight: '700' },
  routeDotTextActive: { color: '#fff' },
  routeStopName: { fontSize: font.label + 1, fontWeight: '500', color: colors.fg2 },
  routeStopNameActive: { color: colors.accentDeep, fontWeight: '700' },
  routeStopMeta: { fontSize: 11, color: colors.fg3, marginTop: 2 },
  stopArrivalBanner: { backgroundColor: colors.infoPale, borderRadius: radius.sm, padding: space.md, marginTop: space.sm },
  stopArrivalTitle: { color: colors.accentDeep, fontSize: font.body, fontWeight: '700' },
  stopArrivalText: { color: colors.fg2, fontSize: font.label + 1, lineHeight: 18, marginTop: 3 },

  seatBar: { flexDirection: 'row', gap: 2, marginTop: space.sm },
  seatCell: { flex: 1, height: 8, borderRadius: 1, backgroundColor: colors.border },
  seatCellFilled: { backgroundColor: colors.accent },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    color: colors.fg3,
    marginTop: space.md,
    marginBottom: space.sm,
  },

  offerCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.md,
  },
  offerHead: { flexDirection: 'row', alignItems: 'center', marginBottom: space.md },
  pill: {
    fontSize: font.label,
    fontWeight: '600',
    color: colors.infoText,
    backgroundColor: colors.infoPale,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  offerCode: { marginLeft: 'auto', fontSize: font.label, color: colors.fg3 },
  offerStop: { fontSize: font.heading, fontWeight: '600', color: colors.fg },
  offerMeta: { fontSize: font.body, color: colors.fg2, marginTop: 2 },
  offerWho: { fontSize: font.label + 1, color: colors.fg3, marginTop: space.xs },
  offerActions: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  acceptButton: {
    flex: 1,
    height: TOUCH_TARGET,
    borderRadius: radius.sm,
    backgroundColor: colors.go,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptText: { color: '#001f30', fontSize: 17, fontWeight: '700' },
  rejectButton: {
    flex: 1,
    height: TOUCH_TARGET,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectText: { color: colors.dangerText, fontSize: 17, fontWeight: '500' },

  queueCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.sm,
  },
  queueHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  queueName: { fontSize: 17, fontWeight: '600', color: colors.fg },
  queueRoute: { fontSize: font.label + 1, color: colors.fg3, marginTop: 2 },
  queueRight: { alignItems: 'flex-end' },
  queueCode: { fontSize: font.label, color: colors.fg3 },
  queuePax: { fontSize: font.body, fontWeight: '600', color: colors.accentDeep, marginTop: 2 },
  advanceButton: {
    height: TOUCH_TARGET,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.md,
  },
  advanceButtonFinal: { backgroundColor: colors.accentDeep },
  advanceText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  buttonDisabled: { opacity: 0.45 },

  emptyCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.xl,
  },
  emptyText: { fontSize: font.body, color: colors.fg3, textAlign: 'center', lineHeight: 21 },

  endShift: {
    height: TOUCH_TARGET,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.xl,
  },
  endShiftText: { color: colors.fg2, fontSize: 17, fontWeight: '500' },
  onboardRoster: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space.lg, marginTop: space.md },
  onboardRosterHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  onboardRosterTitle: { color: colors.fg, fontSize: font.body, fontWeight: '700' },
  onboardRosterHint: { color: colors.fg3, fontSize: font.label, marginTop: 3 },
  clearRosterButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: space.md, borderWidth: 1, borderColor: colors.dangerText, borderRadius: radius.sm },
  clearRosterText: { color: colors.dangerText, fontSize: font.label, fontWeight: '700' },
  onboardRosterScroll: { maxHeight: 220, marginTop: space.sm },
  onboardPassengerRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: space.sm },
  passengerInitial: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentPale },
  passengerInitialText: { color: colors.accentDeep, fontSize: font.body, fontWeight: '700' },
  onboardPassengerName: { color: colors.fg, fontSize: font.label + 1, fontWeight: '600' },
  onboardPassengerMeta: { marginTop: 2, color: colors.fg3, fontSize: 11 },
  passengerInTag: { overflow: 'hidden', color: colors.goText, backgroundColor: colors.goPale, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, fontSize: 10, fontWeight: '800' },
  footNote: {
    marginTop: space.sm,
    fontSize: font.label,
    lineHeight: 17,
    color: colors.fg3,
    textAlign: 'center',
  },
});
