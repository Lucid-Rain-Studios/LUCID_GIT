# Connect a team's Firebase database to Lucid Git

Each team owns its Firebase project. Lucid Git accepts only public web configuration; it never needs a service-account key, GitHub OAuth client secret, or Firebase database secret.

## Firebase prerequisites

1. Create a Firebase project and register a Web app. Analytics and Hosting are optional.
2. Create **Realtime Database**, choosing **Locked mode** and a location near the team.
3. Enable **Authentication > Sign-in method > GitHub**. Register a GitHub OAuth App with the exact callback URL Firebase supplies. Store its Client ID and Client Secret in Firebase only.
4. Copy your Web app configuration and the Realtime Database root URL. Use the default `PROJECT_ID.firebaseapp.com` auth domain.

## Connect and bootstrap the first admin

1. Open this repository in Lucid Git and sign in to the GitHub account with repository admin access.
2. Open **Admin > Team > Connection settings**, or **Settings > Team presence**.
3. Paste the Firebase `firebaseConfig` object and click **Import fields**. Supply the Realtime Database URL if it is absent from that object.
4. **Workspace ID** automatically defaults to the repository folder name in lowercase, with spaces replaced by hyphens (for example, `My Game` becomes `my-game`). Existing saved IDs are preserved; you can edit the default if needed. Use a separate ID for every repository, and the same ID across that repository's clones. IDs accept letters, numbers, underscores and hyphens.
5. Click **Test connection**. Firebase authentication creates your Firebase user. With locked rules, access is expected to be denied; the test still shows **Your Firebase UID**. This is not your GitHub numeric ID or login.
6. In **Firebase Console > Realtime Database > Data**, add a record at `lucidGit/YOUR_WORKSPACE_ID/members/YOUR_FIREBASE_UID`:

   ```json
   {
     "role": "admin",
     "login": "your-github-login",
     "name": "Your Name"
   }
   ```

   Add these nodes under your chosen workspace, preserving existing database data. Do not import this object at the database root.
7. Click **Copy database rules** in Lucid Git. In **Firebase Console > Realtime Database > Rules**, paste those rules and **Publish**. The identical template is in `docs/firebase-presence.rules.json`. It is intended for a database dedicated to Lucid Git. For an existing shared database, merge the `lucidGit` rules deliberately; broader root grants override descendant restrictions.
8. Click **Test connection** again. It must report verified admin reads and own-status publishing. The test briefly writes an Offline session and then removes it. If authentication itself fails, no Firebase UID is available; check the API key and GitHub provider setup first.
9. Check **Enable shared team presence** and click **Save connection**. Changing fields clears the test result, so test the final values before enabling.
10. Commit and push `.lucid-git/firebase-presence.json` in the project repository (for example INFERIUS), then have teammates pull it. They do not need to pull the Lucid Git application's source repository. Ensure the saved configuration has `enabled: true`. It contains public connection identifiers only. Do not commit local activity files or backups.
11. Return to **Admin > Team** and refresh. Your Firebase-backed status should appear. Do not use a packaged application built before the Firebase integration was added.

## Add members and other admins

1. Publish the latest rules from **Copy database rules** or `docs/firebase-presence.rules.json`. Older rules deny automatic registration.
2. Each teammate signs in to GitHub in Lucid Git and opens a clone containing the enabled connection file. On the first heartbeat the app creates their own Firebase UID record with role `member`, GitHub login and display name, then publishes status. No individual member setup is required.
3. To add an admin, open the automatically created record under `lucidGit/YOUR_WORKSPACE_ID/members/UID` in Firebase Console and change `role` to `admin`. Existing admin records are preserved. Reading team activity also requires GitHub repository admin access in Lucid Git.
4. To block a user, set their record's `role` to `disabled`, or disable the user under **Authentication > Users**. Deleting their member record allows automatic registration again. Demote an admin by changing their role to `member`.

Automatic registration admits GitHub-authenticated users as ordinary members; Firebase rules do not independently verify repository membership. Users can create only their own record, once, with role `member`; they cannot edit roles, delete records, register another UID or read the team roster. Login and name are display labels, not authorization keys. The Firebase UID controls access. GitHub role changes do not automatically edit Firebase roles.

## Package and distribute

Build from this updated source using `npm run package` (Windows installer output: `Build/Lucid Git-1.2.0-win-x64.exe`). Share the installer with teammates and share `.lucid-git/firebase-presence.json` through the project repository. Each team supplies its own connection; the app installer contains no team-specific Firebase preset. Publish the latest rules before rollout. Verify one non-admin teammate on another computer appears in the admin Team page and cannot read the roster. Controlled tests and a successful build do not replace this live check.

In the project repository, commit `.lucid-git/firebase-presence.json` and ignore these local files:

```gitignore
/.lucid-git/presence.json
/.lucid-git/*.bak
/.lucid-git/*.tmp
```

If local presence or backup files are already tracked, `.gitignore` alone does not untrack them. Remove them from the index with `git rm --cached` while preserving the files on disk, then commit the tracking removal and `.gitignore` update. Keep the shared Firebase configuration tracked. Unreal `.uproject` changes are separate from presence setup and should be reviewed independently.

## Verify permissions before team rollout

Use Firebase **Rules Playground** with these data paths and Firebase UIDs. Seed the member records in the database first.

| Check | Expected |
| --- | --- |
| Admin GET `/lucidGit/WORKSPACE/presence` | Allowed |
| Member GET the same path | Denied |
| Member GET `/lucidGit/WORKSPACE/members/OWN_UID` | Allowed |
| Member PUT `/lucidGit/WORKSPACE/presence/OWN_UID/DEVICE` with valid status and server timestamp | Allowed |
| Member PUT another UID's presence | Denied |
| Member changes any membership role | Denied |
| GitHub-authenticated user creates their own new record with role `member` | Allowed |
| User creates a record for another UID, creates an admin, edits or deletes an existing record | Denied |
| Authenticated non-member publishes before registration or reads presence | Denied |
| Signed-out user reads or writes presence | Denied |
| Extra fields, an invalid status, or a client-controlled timestamp | Denied |

For a local rules-engine regression, use the Firebase Realtime Database emulator. The app tests use controlled Firebase-shaped HTTP responses; they do not prove your deployed rules or OAuth configuration are correct.

## Activity and connection behavior

- **Active:** Lucid Git runs and the computer is unlocked with input in the last five minutes.
- **Away:** Lucid Git runs but the computer is locked or idle for five minutes.
- **Offline:** The app reports its closure, or its heartbeat is at least 90 seconds old.
- Main-process heartbeats publish every 30 seconds. The admin page polls every 15 seconds; status expiry appears at its next refresh. This REST implementation does not register Firebase `onDisconnect` hooks.
- Multiple computers aggregate into one member: an active device takes precedence over an away device, then offline devices. Device IDs are stored locally; heartbeat records contain only status and Firebase server time.
- Network failures display **unavailable**, never an empty successful team list or a local fallback masquerading as shared activity. Quit attempts a final Offline write but waits at most two seconds; expiry handles interrupted writes.
- Data requests time out and authentication is cached and deduplicated per account/project/workspace. Tokens remain in main-process memory and are never committed to the repository.
- Disabled or unconfigured Firebase connections use explicitly labeled local session data.
- Activity is a recent-input indication, not a guarantee someone is available to respond. No Unreal state, window titles, changed files, branch details or keystrokes are sent.
- Obsolete installation/device records remain Offline. The Firebase owner can remove old presence device nodes when cleaning up the database; membership records determine who is listed.

This integration uses Firebase Authentication and Realtime Database REST APIs. It requires no Cloud Function or automatic GitHub-role synchronization service. Check your Firebase project's usage and billing settings according to your team size.

References: [GitHub provider setup](https://firebase.google.com/docs/auth/web/github-auth), [Auth REST](https://firebase.google.com/docs/reference/rest/auth), [Authenticated database REST](https://firebase.google.com/docs/database/rest/auth), [Rules conditions](https://firebase.google.com/docs/database/security/rules-conditions), [Rules Playground](https://firebase.google.com/docs/rules/simulator).
