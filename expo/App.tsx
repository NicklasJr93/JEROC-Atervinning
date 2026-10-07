import 'react-native-url-polyfill/auto';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

function defaultAddress(): string {
  const configured = process.env.EXPO_PUBLIC_WEB_APP_URL;
  if (configured) return configured;
  const host = Constants.expoConfig?.hostUri;
  if (!host) return '';
  try {
    const url = new URL(host.includes('://') ? host : `http://${host}`);
    return `http://${url.hostname}:4173`;
  } catch {
    return '';
  }
}
function validAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export default function App() {
  const [address, setAddress] = useState(defaultAddress);
  const [editing, setEditing] = useState(!validAddress(address));
  const [entry, setEntry] = useState(address);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const webview = useRef<WebView>(null);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack && !editing && !error) {
        webview.current?.goBack();
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [canGoBack, editing, error]);

  function retry() {
    setError('');
    setLoading(true);
    setReloadKey((key) => key + 1);
  }
  function connect() {
    const next = entry.trim();
    if (!validAddress(next)) {
      setError('Ange en giltig http- eller https-adress till din JEROC-demo.');
      return;
    }
    setAddress(next);
    setEditing(false);
    retry();
  }
  const origin = validAddress(address) ? new URL(address).origin : '';
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        {editing || error ? (
          <ScrollView
            contentContainerStyle={styles.connection}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
          >
            <Text style={styles.brand}>
              JEROC<Text style={styles.brandGreen}> ∞</Text>
            </Text>
            <Text style={styles.subtitle}>Gårdsappen · Expo-demo</Text>
            <Text style={styles.title}>
              {editing ? 'Anslut till din demo' : 'Kan inte ansluta'}
            </Text>
            <Text style={styles.copy}>
              Låt JEROC-startfönstret vara öppet på datorn. Datorn och mobilen
              ska vara på samma wifi.
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {editing ? (
              <>
                <Text style={styles.label}>Adressen från startfönstret</Text>
                <TextInput
                  style={styles.input}
                  value={entry}
                  onChangeText={setEntry}
                  placeholder="http://192.168.1.10:4173"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onSubmitEditing={connect}
                />
                <Pressable style={styles.button} onPress={connect}>
                  <Text style={styles.buttonText}>Öppna demon</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text selectable style={styles.address}>
                  {address}
                </Text>
                <Pressable style={styles.button} onPress={retry}>
                  <Text style={styles.buttonText}>Försök igen</Text>
                </Pressable>
                <Pressable
                  style={styles.secondary}
                  onPress={() => {
                    setEntry(address);
                    setEditing(true);
                    setError('');
                  }}
                >
                  <Text style={styles.secondaryText}>Ändra adress</Text>
                </Pressable>
              </>
            )}
            <Text style={styles.note}>
              Demokonto: niklas / Demo123!{'\n'}Inget skickas till kontoret.
            </Text>
          </ScrollView>
        ) : (
          <View style={styles.webContainer}>
            <WebView
              key={reloadKey}
              ref={webview}
              style={styles.webview}
              source={{ uri: address }}
              originWhitelist={[origin]}
              domStorageEnabled
              cacheEnabled
              javaScriptEnabled
              allowsBackForwardNavigationGestures
              automaticallyAdjustContentInsets={false}
              onShouldStartLoadWithRequest={(request) =>
                request.url === 'about:blank' ||
                request.url === 'about:srcdoc' ||
                request.url === origin ||
                request.url.startsWith(`${origin}/`)
              }
              onNavigationStateChange={(state) => setCanGoBack(state.canGoBack)}
              onLoadStart={() => setLoading(true)}
              onLoadEnd={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setError(
                  'Demon på datorn svarar inte. Kontrollera anslutningen och försök igen.',
                );
              }}
              onHttpError={(event) => {
                if (event.nativeEvent.statusCode >= 400) {
                  setLoading(false);
                  setError(
                    `Demon kunde inte öppnas (HTTP ${event.nativeEvent.statusCode}).`,
                  );
                }
              }}
            />
            {loading && (
              <View style={styles.loading} pointerEvents="none">
                <ActivityIndicator size="large" color="#008854" />
                <Text style={styles.loadingText}>Öppnar gårdsappen…</Text>
              </View>
            )}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  webContainer: { flex: 1 },
  webview: { flex: 1, backgroundColor: '#fff' },
  loading: {
    position: 'absolute',
    inset: 0,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  loadingText: { color: '#6f869b', fontSize: 14 },
  connection: { flexGrow: 1, justifyContent: 'center', padding: 28, gap: 14 },
  brand: {
    color: '#0874f6',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -2,
  },
  brandGreen: { color: '#008854', letterSpacing: 0 },
  subtitle: { color: '#7b90a3', fontSize: 13, marginBottom: 18 },
  title: { color: '#16304d', fontSize: 25, fontWeight: '700' },
  copy: { color: '#6f869b', fontSize: 14, lineHeight: 22 },
  error: {
    color: '#ad4940',
    backgroundColor: '#fff1ee',
    padding: 14,
    borderRadius: 10,
    fontSize: 13,
    lineHeight: 21,
  },
  label: { color: '#536f88', fontSize: 12, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#dce7f2',
    borderRadius: 10,
    padding: 15,
    color: '#16304d',
    backgroundColor: '#f8fbfe',
    fontSize: 15,
  },
  button: {
    backgroundColor: '#008854',
    padding: 17,
    borderRadius: 11,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  secondary: { padding: 14, alignItems: 'center' },
  secondaryText: { color: '#116df4', fontSize: 14 },
  address: { color: '#6584a1', fontSize: 13, paddingVertical: 8 },
  note: { color: '#8b9dad', fontSize: 12, lineHeight: 20, marginTop: 10 },
});
