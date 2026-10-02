export const firebasePresenceRules = {
  rules: {
    '.read': false,
    '.write': false,
    lucidGit: {
      '$workspace': {
        members: {
          '.read': "auth != null && root.child('lucidGit').child($workspace).child('members').child(auth.uid).child('role').val() === 'admin'",
          '$uid': {
            '.read': 'auth != null && auth.uid === $uid',
            '.write': "auth != null && auth.uid === $uid && auth.token.firebase.sign_in_provider === 'github.com' && !data.exists() && newData.exists() && newData.child('role').val() === 'member'",
            '.validate': "newData.hasChildren(['role', 'login', 'name'])",
            role: { '.validate': "newData.val() === 'member'" },
            login: { '.validate': "newData.isString() && newData.val().length > 0 && newData.val().length <= 39 && newData.val().matches(/^[A-Za-z0-9-]+$/)" },
            name: { '.validate': 'newData.isString() && newData.val().length > 0 && newData.val().length <= 100' },
            '$other': { '.validate': false },
          },
        },
        presence: {
          '.read': "auth != null && root.child('lucidGit').child($workspace).child('members').child(auth.uid).child('role').val() === 'admin'",
          '$uid': {
            '$device': {
              '.write': "auth != null && auth.uid === $uid && (root.child('lucidGit').child($workspace).child('members').child(auth.uid).child('role').val() === 'admin' || root.child('lucidGit').child($workspace).child('members').child(auth.uid).child('role').val() === 'member')",
              '.validate': "newData.hasChildren(['status', 'lastSeen'])",
              status: { '.validate': "newData.isString() && (newData.val() === 'active' || newData.val() === 'away' || newData.val() === 'offline')" },
              lastSeen: { '.validate': 'newData.isNumber() && newData.val() === now' },
              '$other': { '.validate': false },
            },
          },
        },
      },
    },
  },
}
