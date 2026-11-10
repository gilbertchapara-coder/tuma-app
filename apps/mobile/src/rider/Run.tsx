import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CustodyEvent } from '@tuma/core/src/custody';
import { colors, fonts, space, TOUCH } from '../theme';
import { flushQueue, enqueueEvent, pendingCount, pendingParcelIds, type Send } from './scanQueue';

export interface RunParcel {
  id: string;
  suburb: string;
}

export type DeliverOutcome = 'ok' | 'wrong_code' | 'locked' | 'no_signal';

interface RunProps {
  parcels: RunParcel[];
  send: Send;
  deliver: (parcelId: string, code: string) => Promise<DeliverOutcome>;
}

const CODE_LENGTH = 6;
const SAVED = 'Saved, will send';
const DELIVER_MESSAGES: Record<Exclude<DeliverOutcome, 'ok'>, string> = {
  wrong_code: 'That code is not right. Ask the recipient again.',
  locked: 'Too many wrong tries. Call Tuma support.',
  no_signal: 'No signal. Try again when you have signal.',
};

export function Run({ parcels, send, deliver }: RunProps) {
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, true>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [delivered, setDelivered] = useState<Record<string, true>>({});
  const busy = useRef(new Set<string>());
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const setStatusFor = (id: string, text: string) => setStatus((s) => ({ ...s, [id]: text }));

  const syncNow = useCallback(async () => {
    await flushQueue(send);
    const count = await pendingCount();
    if (live.current) setPending(count);
  }, [send]);

  useEffect(() => {
    void syncNow();
  }, [syncNow]);

  const confirmPickup = async (id: string) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    try {
      // Stamp the time of the scan now. If there is no signal it is sent later with this same time.
      const event: CustodyEvent = { type: 'pickup_confirmed', at: new Date().toISOString(), actor: 'rider' };
      await enqueueEvent(id, event);
      setPicked((p) => ({ ...p, [id]: true }));
      await flushQueue(send);
      const waiting = await pendingParcelIds();
      if (!live.current) return;
      setStatusFor(id, waiting.includes(id) ? SAVED : 'Sent');
      setPending(await pendingCount());
    } finally {
      busy.current.delete(id);
    }
  };

  const confirmDelivery = async (id: string) => {
    const code = codes[id] ?? '';
    if (busy.current.has(id) || code.length !== CODE_LENGTH) return;
    busy.current.add(id);
    try {
      const outcome = await deliver(id, code);
      if (!live.current) return;
      if (outcome === 'ok') {
        setDelivered((d) => ({ ...d, [id]: true }));
        setStatusFor(id, 'Delivered');
      } else {
        setStatusFor(id, DELIVER_MESSAGES[outcome]);
      }
    } catch {
      if (live.current) setStatusFor(id, DELIVER_MESSAGES.no_signal);
    } finally {
      busy.current.delete(id);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1} accessibilityRole="header">Your run</Text>
      {pending > 0 && (
        <Text style={styles.warn} accessibilityLiveRegion="polite">
          {`${pending} ${pending === 1 ? 'scan' : 'scans'} waiting to send`}
        </Text>
      )}
      {parcels.map((p) => {
        const isDelivered = delivered[p.id] === true;
        const code = codes[p.id] ?? '';
        const canDeliver = code.length === CODE_LENGTH;
        return (
          <View key={p.id} style={styles.card}>
            <Text style={styles.suburb}>{p.suburb}</Text>
            {!isDelivered && (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm pickup, ${p.suburb}`}
                  accessibilityState={{ disabled: picked[p.id] === true }}
                  disabled={picked[p.id] === true}
                  onPress={() => confirmPickup(p.id)}
                  style={[styles.secondary, picked[p.id] === true && styles.off]}
                >
                  <Text style={styles.secondaryText}>Confirm pickup</Text>
                </Pressable>
                <TextInput
                  accessibilityLabel={`Delivery code for ${p.suburb}`}
                  value={code}
                  onChangeText={(v) => setCodes((c) => ({ ...c, [p.id]: v.replace(/\D/g, '').slice(0, CODE_LENGTH) }))}
                  keyboardType="number-pad"
                  maxLength={CODE_LENGTH}
                  placeholder="6 digit code"
                  placeholderTextColor={colors.inkSoft}
                  style={styles.input}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Deliver, ${p.suburb}`}
                  accessibilityState={{ disabled: !canDeliver }}
                  disabled={!canDeliver}
                  onPress={() => confirmDelivery(p.id)}
                  style={[styles.primary, !canDeliver && styles.off]}
                >
                  <Text style={styles.primaryText}>Deliver</Text>
                </Pressable>
              </>
            )}
            {status[p.id] ? <Text style={styles.status} accessibilityLiveRegion="polite">{status[p.id]}</Text> : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { padding: space.m, paddingBottom: space.l * 2 },
  h1: { fontFamily: fonts.heading, fontSize: 26, color: colors.ink },
  warn: { fontFamily: fonts.bodyBold, fontSize: 15, color: colors.accent, marginTop: space.s },
  card: { paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: colors.line, gap: space.s },
  suburb: { fontFamily: fonts.heading, fontSize: 20, color: colors.ink },
  secondary: { minHeight: TOUCH, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.ink, borderRadius: 8 },
  secondaryText: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.ink },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.m, fontFamily: fonts.body, fontSize: 18, color: colors.ink, backgroundColor: '#ffffff' },
  primary: { minHeight: 52, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 8 },
  primaryText: { fontFamily: fonts.bodyBold, fontSize: 17, color: colors.onAccent },
  off: { opacity: 0.45 },
  status: { fontFamily: fonts.bodyBold, fontSize: 15, color: colors.ink },
});
