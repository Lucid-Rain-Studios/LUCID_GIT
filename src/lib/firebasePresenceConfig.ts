import type { FirebasePresenceConfig } from '@/ipc'

export function parseFirebaseWebConfig(text: string): Partial<FirebasePresenceConfig> {
  if (text.length > 16_000) throw new Error('Paste only the Firebase web configuration object.')
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Paste the firebaseConfig object shown in Firebase project settings.')
  // Firebase's sample uses unquoted property names. Parse data without evaluating JavaScript.
  const object = text.slice(start, end + 1).replace(/([{,]\s*)([A-Za-z][A-Za-z0-9_]*)\s*:/g, '$1"$2":').replace(/,\s*}/g, '}')
  const parsed = JSON.parse(object)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Firebase web configuration.')
  const allowed = ['apiKey', 'authDomain', 'projectId', 'databaseURL', 'appId', 'storageBucket', 'messagingSenderId', 'measurementId']
  if (Object.keys(parsed).some(key => !allowed.includes(key))) throw new Error('Use public web configuration only. Do not paste a client secret or service-account key.')
  const result: Partial<FirebasePresenceConfig> = {}
  for (const key of ['apiKey', 'authDomain', 'projectId', 'databaseURL'] as const) {
    if (parsed[key] !== undefined) {
      if (typeof parsed[key] !== 'string') throw new Error(`Invalid ${key}.`)
      result[key] = parsed[key]
    }
  }
  if (!result.apiKey || !result.authDomain || !result.projectId) throw new Error('The web configuration must include apiKey, authDomain and projectId.')
  return result
}

