const express = require('express');
const path = require('path');
const { createDownloadsRouter } = require('./downloads');

const app = express();
const PORT = process.env.PORT || 3000;

// Раздача APK кассы. Объявлена ДО express.static: статика отдала бы файл
// под его внутренним именем и без типа application/vnd.android.package-archive,
// а нам нужно имя с меткой организации и корректный тип для установщика.
app.use('/downloads', createDownloadsRouter());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'frontend-service' });
});

// Redirect root to organization login (public storefront removed)
app.get('/', (req, res) => {
  res.redirect('/admin-panel/login.html');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Frontend service listening on port ${PORT}`);
});
