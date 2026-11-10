import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, fonts, space, TOUCH } from '../theme';
import {
  EMPTY_FORM,
  LEVELS,
  SUBURB_NAMES,
  formatDollars,
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

const BOOK_ERROR = 'We could not book this parcel. Check your connection and try again.';

export function BookParcel({ pickPhoto, onSubmit }: BookParcelProps) {
  const [form, setForm] = useState<BookingForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const set = (patch: Partial<BookingForm>) => setForm((f) => ({ ...f, ...patch }));
  const price = quote(form);
  const payload = toPayload(form);
  const canSubmit = payload !== null && !busy;

  const addPhoto = async () => {
    const url = await pickPhoto();
    if (url) set({ sealedPhotoUrl: url });
  };

  const submit = async () => {
    if (!payload || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(payload);
      setForm(EMPTY_FORM);
    } catch {
      setError(BOOK_ERROR);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1} accessibilityRole="header">Book a parcel</Text>

      <Text style={styles.label}>Where is it going?</Text>
      <View style={styles.chips}>
        {SUBURB_NAMES.map((name) => (
          <Chip key={name} label={name} selected={form.suburb === name} onPress={() => set({ suburb: name })} />
        ))}
      </View>

      <Text style={styles.label}>How fast?</Text>
      <View style={styles.chips}>
        {LEVELS.map((l) => (
          <Chip
            key={l.id}
            label={`${l.label}, ${l.hint}`}
            selected={form.level === l.id}
            onPress={() => set({ level: l.id })}
          />
        ))}
      </View>

      {price !== null && <Text style={styles.price} accessibilityLiveRegion="polite">{`Price: ${formatDollars(price)}`}</Text>}

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

      <Pressable accessibilityRole="button" accessibilityLabel="Add photo of sealed parcel" onPress={addPhoto} style={styles.secondary}>
        <Text style={styles.secondaryText}>Add photo of sealed parcel</Text>
      </Pressable>
      {form.sealedPhotoUrl && <Text style={styles.note}>Photo added</Text>}

      {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Book parcel"
        accessibilityState={{ disabled: !canSubmit }}
        disabled={!canSubmit}
        onPress={submit}
        style={[styles.primary, !canSubmit && styles.primaryOff]}
      >
        <Text style={styles.primaryText}>{busy ? 'Booking...' : 'Book parcel'}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipOn]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
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
  screen: { padding: space.m, paddingBottom: space.l * 2, backgroundColor: colors.paper },
  h1: { fontFamily: fonts.heading, fontSize: 28, color: colors.ink, marginBottom: space.s },
  label: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.ink, marginTop: space.m, marginBottom: space.s },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { minHeight: TOUCH, paddingHorizontal: space.m, justifyContent: 'center', borderWidth: 1, borderColor: colors.line, borderRadius: 8 },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: fonts.body, fontSize: 16, color: colors.ink },
  chipTextOn: { color: colors.paper },
  price: { fontFamily: fonts.heading, fontSize: 22, color: colors.ink, marginTop: space.m },
  input: { minHeight: TOUCH, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.m, fontFamily: fonts.body, fontSize: 16, color: colors.ink, backgroundColor: '#ffffff' },
  note: { fontFamily: fonts.body, fontSize: 14, color: colors.inkSoft, marginTop: space.s },
  error: { fontFamily: fonts.body, fontSize: 14, color: colors.accent, marginTop: space.s },
  secondary: { minHeight: TOUCH, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: colors.ink, borderRadius: 8, marginTop: space.l },
  secondaryText: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.ink },
  primary: { minHeight: TOUCH, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.accent, borderRadius: 8, marginTop: space.m },
  primaryOff: { backgroundColor: colors.disabled },
  primaryText: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.onAccent },
});
