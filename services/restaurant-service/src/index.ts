import express from 'express';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'restaurant-service' });
});

app.listen(PORT, () => {
  console.log(`Restaurant service listening on port ${PORT}`);
});
