# Firebase Deployment Guide

## Prerequisites
1. Install Firebase CLI: `npm install -g firebase-tools`
2. Login to Firebase: `firebase login`
3. Create a Firebase project at https://console.firebase.google.com

## Setup

### 1. Update Project ID
Edit `.firebaserc` and replace `your-firebase-project-id` with your actual Firebase project ID.

### 2. Enable Firestore
Go to Firebase Console > Firestore Database > Create Database

### 3. Set Environment Variables
```bash
firebase functions:config:set aps.client_id="YOUR_APS_CLIENT_ID"
firebase functions:config:set aps.client_secret="YOUR_APS_CLIENT_SECRET"
firebase functions:config:set anthropic.api_key="YOUR_ANTHROPIC_API_KEY"
```

### 4. Install Dependencies
```bash
cd functions
npm install
cd ..
```

### 5. Deploy
```bash
firebase deploy
```

Or deploy separately:
```bash
firebase deploy --only hosting
firebase deploy --only functions
```

## URLs After Deployment
- Frontend: `https://YOUR-PROJECT-ID.web.app`
- API: `https://YOUR-REGION-YOUR-PROJECT-ID.cloudfunctions.net/api`

## Local Testing
```bash
firebase emulators:start
```

## Notes
- Cloud Functions timeout: 540 seconds (9 minutes)
- Memory: 2GB
- Puppeteer is not available in Cloud Functions, using thumbnail fallback
- Instructions are stored in Firestore
