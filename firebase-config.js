(() => {
  'use strict';

  // Firebase Web App config. Nilai ini bukan password, tetapi tetap harus
  // dipasangkan dengan Authentication + Realtime Database Rules yang ketat.
  window.KBFirebaseConfig = Object.freeze({
    firebaseConfig: Object.freeze({
      apiKey: 'AIzaSyCnYxDHBfxp3TvbdP4O3g6j_RSo5Eh_9-Y',
      authDomain: 'kb-bank-realtime.firebaseapp.com',
      databaseURL: 'https://kb-bank-realtime-default-rtdb.asia-southeast1.firebasedatabase.app',
      projectId: 'kb-bank-realtime',
      storageBucket: 'kb-bank-realtime.firebasestorage.app',
      messagingSenderId: '249736110361',
      appId: '1:249736110361:web:40d517202485481e61a588',
      measurementId: 'G-8HW6QJMH4C'
    }),
    // Harus sama dengan akun Firebase Authentication yang dipakai untuk login Admin.
    adminEmail: 'dendiking56@gmail.com'
  });
})();
