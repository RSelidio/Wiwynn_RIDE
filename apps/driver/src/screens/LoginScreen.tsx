import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, radius, space, TOUCH_TARGET, type as font } from '../lib/theme';

export function LoginScreen({
  onSubmit,
  error,
  busy,
}: {
  onSubmit: (email: string, password: string) => void;
  error: string | null;
  busy: boolean;
}) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');

  const canSubmit = email.trim() !== '' && password !== '' && !busy;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.brand}>Shuttle Driver</Text>
          <Text style={styles.subtitle}>Sign in with your company driver account</Text>

          <Text style={styles.label}>EMAIL</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@wiwynn.com"
            placeholderTextColor={colors.fg3}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            style={styles.input}
            editable={!busy}
          />

          <Text style={styles.label}>PASSWORD</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            style={styles.input}
            editable={!busy}
            onSubmitEditing={() => {
              if (canSubmit) onSubmit(email.trim(), password);
            }}
          />

          {error != null && (
            <View style={styles.error} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            onPress={() => onSubmit(email.trim(), password)}
            disabled={!canSubmit}
            accessibilityRole="button"
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.hint}>
            Your shuttle&rsquo;s position is shared with waiting employees only while your shift is
            active.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.page },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: space.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.xl,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  brand: { fontSize: font.heading, fontWeight: '700', color: colors.accentText },
  subtitle: { fontSize: font.body, color: colors.fg3, marginTop: space.xs, marginBottom: space.xl },
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    color: colors.fg3,
    marginBottom: space.xs,
  },
  input: {
    height: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    fontSize: 17,
    color: colors.fg,
    backgroundColor: colors.surface,
    marginBottom: space.lg,
  },
  error: {
    backgroundColor: colors.dangerPale,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.lg,
  },
  errorText: { color: colors.dangerText, fontSize: font.body },
  button: {
    height: TOUCH_TARGET,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  hint: {
    marginTop: space.lg,
    fontSize: font.label,
    lineHeight: 18,
    color: colors.fg3,
    textAlign: 'center',
  },
});
