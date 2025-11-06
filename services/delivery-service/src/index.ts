import express from 'express';

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'delivery-service' });
});

app.listen(PORT, () => {
  console.log(`Delivery service listening on port ${PORT}`);
});
