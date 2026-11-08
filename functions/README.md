# Cloud Functions

The Google login function verifies Google ID tokens against the project's OAuth Web Client ID before issuing a Firebase custom token. Enable Google as a sign-in provider in Firebase Authentication, then deploy the function:

```powershell
firebase deploy --only functions:loginWithGoogleIdentity
```

During deployment, provide `GOOGLE_OAUTH_WEB_CLIENT_ID` using the Web Client ID configured for the Firebase Google provider. The ID is public configuration, not a secret.
