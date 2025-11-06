import express from 'express';
import cors from 'cors';
import ordersRouter from './routes/orders';

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'order-service' });
});

// Routes
app.use('/api/orders', ordersRouter);

app.listen(PORT, () => {
  console.log(`Order service listening on port ${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api/orders`);
});
