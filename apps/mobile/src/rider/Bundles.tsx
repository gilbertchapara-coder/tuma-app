import { useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { capCents, type Tier } from '@tuma/core/src/tiers';
import { colors, fonts, space } from '../theme';
import { formatDollars, levelLabel } from '../shop/bookingForm';

export interface RiderSummary {
  tier: Tier;
  balanceCents: number;
  depositCents: number;
}

export interface OpenBundle {
  id: string;
  run: string;
  level: string;
  dropOrder: string[];
  parcelCount: number;
}

export type AcceptOutcome = 'ok' | 'taken' | 'insufficient_float' | 'over_cap' | 'failed';

interface BundlesProps {
  summary: RiderSummary;
  bundles: OpenBundle[];
  onAccept: (bundleId: string) => Promise<AcceptOutcome>;
}

const TIER_NAMES: Record<Tier, string> = {
  unverified: 'Not verified yet',
  new: 'New rider',
  trusted: 'Trusted rider',
  senior: 'Senior rider',
};
const RUN_NAMES: Record<string, string> = { north: 'North', southwest: 'South-West', south: 'South' };
const TOP_UP = 'Top up to accept';

const MESSAGES: Record<AcceptOutcome, string> = {
  ok: 'Bundle accepted. Go to your run.',
  taken: 'Another rider took this bundle. Pick another.',
  insufficient_float: TOP_UP,
  over_cap: 'A parcel in this bundle is worth more than your level allows.',
  failed: 'We could not accept this bundle. Check your signal and try again.',
};

const capLine = (tier: Tier): string =>
  tier === 'unverified'
    ? 'You cannot carry parcels yet. Ask Tuma to verify you.'
    : `You can carry parcels worth up to ${formatDollars(capCents(tier))} each`;

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function Bundles({ summary, bundles, onAccept }: BundlesProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const noFloat = summary.balanceCents <= 0;

  const accept = async (id: string) => {
    if (inFlight.current || noFloat) return;
    inFlight.current = true;
    setBusy(true);
    setStatus(null);
    try {
      setStatus(MESSAGES[await onAccept(id)]);
    } catch {
      setStatus(MESSAGES.failed);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const canAccept = !noFloat && !busy;

  return (
    <View style={styles.screen}>
      <Text style={styles.h1} accessibilityRole="header">{TIER_NAMES[summary.tier]}</Text>
      <Text style={styles.sub}>{capLine(summary.tier)}</Text>
      <Text style={styles.sub}>{`Float: ${formatDollars(summary.balanceCents)}`}</Text>
      {noFloat && <Text style={styles.warn} accessibilityLiveRegion="polite">{TOP_UP}</Text>}
      {status && <Text style={styles.status} accessibilityLiveRegion="polite">{status}</Text>}

      {bundles.length === 0 ? (
        <Text style={styles.note}>No bundles right now. Check again soon.</Text>
      ) : (
        <FlatList
          data={bundles}
          keyExtractor={(b) => b.id}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.main}>
                <Text style={styles.title}>{`${RUN_NAMES[item.run] ?? cap(item.run)} run, ${levelLabel(item.level as never) || cap(item.level)}`}</Text>
                <Text style={styles.detail}>
                  {`${item.parcelCount} ${item.parcelCount === 1 ? 'parcel' : 'parcels'}: ${item.dropOrder.join(', ')}`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Accept ${RUN_NAMES[item.run] ?? item.run} run`}
                accessibilityState={{ disabled: !canAccept }}
                disabled={!canAccept}
                onPress={() => accept(item.id)}
                style={[styles.accept, !canAccept && styles.acceptOff]}
              >
                <Text style={styles.acceptText}>Accept</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: space.m, backgroundColor: colors.paper },
  h1: { fontFamily: fonts.heading, fontSize: 26, color: colors.ink },
  sub: { fontFamily: fonts.body, fontSize: 15, color: colors.inkSoft, marginTop: 4 },
  warn: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.accent, marginTop: space.s },
  status: { fontFamily: fonts.bodyBold, fontSize: 15, color: colors.ink, marginTop: space.s },
  note: { fontFamily: fonts.body, fontSize: 16, color: colors.ink, marginTop: space.l },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: colors.line, gap: space.m },
  main: { flex: 1 },
  title: { fontFamily: fonts.heading, fontSize: 18, color: colors.ink },
  detail: { fontFamily: fonts.body, fontSize: 14, color: colors.inkSoft },
  accept: { minHeight: 48, minWidth: 88, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: space.m },
  acceptOff: { backgroundColor: colors.disabled },
  acceptText: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.onAccent },
});
