import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, space } from '../theme';
import { formatDollars } from './bookingForm';

export interface ParcelRow {
  id: string;
  suburb: string;
  level: string;
  priceCents: number;
  stage: string;
  createdAt: string;
}

interface MyParcelsProps {
  load: () => Promise<ParcelRow[]>;
}

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; rows: ParcelRow[] };

export function MyParcels({ load }: MyParcelsProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    load().then(
      (rows) => live && setState({ kind: 'ready', rows }),
      () => live && setState({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [load]);

  if (state.kind === 'loading') return <Text style={styles.note} accessibilityLiveRegion="polite">Loading your parcels...</Text>;
  if (state.kind === 'error') {
    return <Text style={styles.note} accessibilityLiveRegion="polite">We could not load your parcels. Pull down to try again.</Text>;
  }
  if (state.rows.length === 0) return <Text style={styles.note}>No parcels yet. Book your first one.</Text>;

  return (
    <FlatList
      data={state.rows}
      keyExtractor={(r) => r.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <View style={styles.row} accessible>
          <View style={styles.main}>
            <Text style={styles.suburb}>{item.suburb}</Text>
            <Text style={styles.stage}>{item.stage}</Text>
          </View>
          <Text style={styles.price}>{formatDollars(item.priceCents)}</Text>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: space.m, backgroundColor: colors.paper },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: colors.line },
  main: { flex: 1, paddingRight: space.m },
  suburb: { fontFamily: fonts.heading, fontSize: 18, color: colors.ink },
  stage: { fontFamily: fonts.body, fontSize: 14, color: colors.inkSoft },
  price: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.ink },
  note: { fontFamily: fonts.body, fontSize: 16, color: colors.ink, padding: space.m },
});
