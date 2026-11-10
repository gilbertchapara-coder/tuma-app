import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, fonts, space, TOUCH } from '../theme';
import { priceCents } from '@tuma/core/src/pricing';
import { SUBURBS } from '@tuma/core/src/suburbs';
import {
  EMPTY_FORM,
  LEVELS,
  SUBURB_NAMES,
  detailsValid,
  formatDollars,
  levelLabel,
  phonesMismatch,
  quote,
  toPayload,
  type BookingForm,
  type BookingPayload,
} from './bookingForm';

interface BookParcelProps {
  /** Opens the camera and resolves with an uploaded photo URL, or null if cancelled. */
  pickPhoto: () => Promise<string | null>;
  onSubmit: (payload: BookingPayload) => Promise<void>;
}

type Step = 0 | 1 | 2 | 3;

const STEP_TITLES = ['Where is it going?', 'How fast?', 'Parcel and recipient', 'Photo and confirm'] as const;
const BOOK_ERROR = 'We could not book this parcel. Check your connection and try again.';

export function BookParcel({ pickPhoto, onSubmit }: BookParcelProps) {
  const [form, setForm] = useState<BookingForm>(EMPTY_FORM);
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const set = (patch: Partial<BookingForm>) => setForm((f) => ({ ...f, ...patch }));
  const price = quote(form);
  const payload = toPayload(form);

  const stepReady = [form.suburb !== null, form.level !== null, detailsValid(form), payload !== null][step] ?? false;
  const priceText = price === null ? '' : formatDollars(price);
  const isLast = step === 3;
  const actionLabel = isLast ? 'Book parcel' : 'Next';
  const actionWithPrice = step >= 1 && priceText ? `${actionLabel}, ${priceText}` : actionLabel;
  const canAct = stepReady && !busy;

  const goBack = () => step > 0 && setStep((s) => (s - 1) as Step);

  const addPhoto = async () => {
    const url = await pickPhoto();
    if (url) set({ sealedPhotoUrl: url });
  };

  const book = async () => {
    if (!payload || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(payload);
      setForm(EMPTY_FORM);
      setStep(0);
    } catch {
      setError(BOOK_ERROR);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const act = () => {
    if (!canAct) return;
    if (isLast) void book();
    else setStep((s) => (s + 1) as Step);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        {step > 0 ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} style={styles.back}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        ) : (
          <View style={styles.back} />
        )}
        <View style={styles.progress} accessibilityLabel={`Step ${step + 1} of 4`}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.progressPip, i <= step && styles.progressPipOn]} />
          ))}
        </View>
        <Text style={styles.h1} accessibilityRole="header">{STEP_TITLES[step]}</Text>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
        {step === 0 && (
          <View>
            {SUBURB_NAMES.map((name) => (
              <Row
                key={name}
                label={name}
                detail={SUBURBS[name]?.band}
                selected={form.suburb === name}
                onPress={() => set({ suburb: name })}
              />
            ))}
          </View>
        )}

        {step === 1 && form.suburb && (
          <View>
            {LEVELS.map((l) => (
              <Row
                key={l.id}
                label={l.label}
                detail={l.hint}
                price={formatDollars(priceCents(form.suburb as string, l.id))}
                selected={form.level === l.id}
                onPress={() => set({ level: l.id })}
              />
            ))}
          </View>
        )}

        {step === 2 && (
          <View>
            <Field label="What is in the parcel" value={form.contents} onChangeText={(contents) => set({ contents })} />
            <Field
              label="Value in dollars"
              value={form.valueText}
              keyboardType="decimal-pad"
              onChangeText={(valueText) => set({ valueText })}
            />
            <Field
              label="Recipient phone"
              value={form.recipientPhone}
              keyboardType="phone-pad"
              placeholder="+263 77 123 4567"
              onChangeText={(recipientPhone) => set({ recipientPhone })}
            />
            <Field
              label="Type the recipient phone again"
              value={form.recipientPhoneConfirm}
              keyboardType="phone-pad"
              onChangeText={(recipientPhoneConfirm) => set({ recipientPhoneConfirm })}
            />
            {phonesMismatch(form) && (
              <Text style={styles.error} accessibilityLiveRegion="polite">The two phone numbers do not match</Text>
            )}
          </View>
        )}

        {step === 3 && (
          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add photo of sealed parcel"
              onPress={addPhoto}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>Add photo of sealed parcel</Text>
            </Pressable>
            {form.sealedPhotoUrl && <Text style={styles.note}>Photo added</Text>}
            <View style={styles.summary}>
              <SummaryLine k="To" v={form.suburb ?? ''} />
              <SummaryLine k="Speed" v={levelLabel(form.level)} />
              <SummaryLine k="Recipient" v={form.recipientPhone} />
              <SummaryLine k="Price" v={priceText} strong />
            </View>
            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
          </View>
        )}
      </ScrollView>

      <View style={styles.foot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionWithPrice}
          accessibilityState={{ disabled: !canAct }}
          disabled={!canAct}
          onPress={act}
          style={[styles.primary, !canAct && styles.primaryOff]}
        >
          <Text style={styles.primaryText}>{busy ? 'Booking...' : actionWithPrice}</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface RowProps {
  label: string;
  detail?: string | undefined;
  price?: string;
  selected: boolean;
  onPress: () => void;
}

function Row({ label, detail, price, selected, onPress }: RowProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={styles.row}
    >
      <View style={[styles.radio, selected && styles.radioOn]} />
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, selected && styles.rowLabelOn]}>{label}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      {price ? <Text style={styles.rowPrice}>{price}</Text> : null}
    </Pressable>
  );
}

function SummaryLine({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <View style={styles.summaryLine}>
      <Text style={styles.summaryKey}>{k}</Text>
      <Text style={[styles.summaryValue, strong && styles.summaryStrong]}>{v}</Text>
    </View>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: 'default' | 'decimal-pad' | 'phone-pad';
  placeholder?: string;
}

/** Label sits above the input; the placeholder is only ever an example. */
function Field({ label, value, onChangeText, keyboardType = 'default', placeholder }: FieldProps) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  bar: { paddingHorizontal: space.m, paddingTop: space.m },
  back: { minHeight: 32, justifyContent: 'center' },
  backText: { fontFamily: fonts.body, fontSize: 14, color: colors.inkSoft },
  progress: { flexDirection: 'row', gap: 6, marginVertical: space.s },
  progressPip: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.line },
  progressPipOn: { backgroundColor: colors.ink },
  h1: { fontFamily: fonts.heading, fontSize: 26, color: colors.ink },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: space.m, paddingBottom: space.l },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.ink, marginRight: space.m },
  radioOn: { backgroundColor: colors.ink },
  rowMain: { flex: 1 },
  rowLabel: { fontFamily: fonts.body, fontSize: 16, color: colors.ink },
  rowLabelOn: { fontFamily: fonts.bodyBold },
  rowDetail: { fontFamily: fonts.body, fontSize: 13, color: colors.inkSoft },
  rowPrice: { fontFamily: fonts.heading, fontSize: 20, color: colors.ink },
  label: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.ink, marginTop: space.m, marginBottom: space.s },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.m, fontFamily: fonts.body, fontSize: 16, color: colors.ink, backgroundColor: '#ffffff' },
  note: { fontFamily: fonts.body, fontSize: 14, color: colors.inkSoft, marginTop: space.s },
  error: { fontFamily: fonts.body, fontSize: 14, color: colors.accent, marginTop: space.s },
  secondary: { minHeight: TOUCH, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.ink, borderRadius: 8, marginTop: space.m },
  secondaryText: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.ink },
  summary: { marginTop: space.l, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.s },
  summaryLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  summaryKey: { fontFamily: fonts.body, fontSize: 15, color: colors.inkSoft },
  summaryValue: { fontFamily: fonts.bodyBold, fontSize: 15, color: colors.ink },
  summaryStrong: { fontFamily: fonts.heading, fontSize: 20 },
  foot: { padding: space.m, borderTopWidth: 1, borderTopColor: colors.line },
  primary: { minHeight: 52, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 8 },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { fontFamily: fonts.bodyBold, fontSize: 17, color: colors.onAccent },
});
