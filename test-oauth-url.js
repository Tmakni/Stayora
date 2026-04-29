require('dotenv').config();
const { google } = require('googleapis');

const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email'
  ]
});

console.log('=== OAuth Config Test ===');
console.log('Client ID:', process.env.GOOGLE_CLIENT_ID ? 'SET (' + process.env.GOOGLE_CLIENT_ID.substring(0, 20) + '...)' : 'MISSING');
console.log('Client Secret:', process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING');
console.log('Redirect URI:', process.env.GOOGLE_REDIRECT_URI);
console.log('OAuth URL OK:', url.startsWith('https://accounts.google.com'));
console.log('\nFull OAuth URL:');
console.log(url);
