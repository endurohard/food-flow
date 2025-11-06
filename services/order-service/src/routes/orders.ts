import { Router, Request, Response } from 'express';

const router = Router();

// In-memory storage (в production использовать PostgreSQL)
interface Order {
  id: number;
  restaurantId: number;
  customerId?: number | null;
  customer: {
    name: string;
    phone: string;
  };
  deliveryAddress?: string;
  items: Array<{
    menuItemId: number;
    name: string;
    quantity: number;
    price: number;
    specialInstructions?: string;
  }>;
  subtotal: number;
  deliveryFee: number;
  tax: number;
  total: number;
  specialInstructions?: string;
  orderType: 'delivery' | 'pickup' | 'dine-in';
  paymentMethod: string;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'cancelled';
  courierId?: number | null;
  courierName?: string;
  createdAt: Date;
  updatedAt: Date;
}

let orders: Order[] = [];
let nextOrderId = 1;

/**
 * GET /api/orders
 * Получить все заказы
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    console.error('Failed to get orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get orders',
    });
  }
});

/**
 * GET /api/orders/:id
 * Получить заказ по ID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const order = orders.find((o) => o.id === id);

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error('Failed to get order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get order',
    });
  }
});

/**
 * POST /api/orders
 * Создать новый заказ
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      restaurantId,
      customerId,
      customer,
      deliveryAddress,
      items,
      subtotal,
      deliveryFee,
      tax,
      total,
      specialInstructions,
      orderType,
      paymentMethod,
    } = req.body;

    // Валидация
    if (!restaurantId || !customer || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const newOrder: Order = {
      id: nextOrderId++,
      restaurantId,
      customerId: customerId || null,
      customer,
      deliveryAddress,
      items,
      subtotal: subtotal || 0,
      deliveryFee: deliveryFee || 0,
      tax: tax || 0,
      total: total || 0,
      specialInstructions: specialInstructions || '',
      orderType: orderType || 'delivery',
      paymentMethod: paymentMethod || 'cash',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    orders.push(newOrder);

    console.log(`Order created: #${newOrder.id} - ${customer.name} - ${total} ₽`);

    // TODO: Отправить заказ в RabbitMQ для kitchen-service

    res.status(201).json({
      success: true,
      data: newOrder,
      message: 'Order created successfully',
    });
  } catch (error) {
    console.error('Failed to create order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create order',
    });
  }
});

/**
 * PUT /api/orders/:id
 * Обновить статус заказа
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const index = orders.findIndex((o) => o.id === id);

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    const { status, courierId, courierName } = req.body;

    orders[index] = {
      ...orders[index],
      status: status || orders[index].status,
      courierId: courierId !== undefined ? courierId : orders[index].courierId,
      courierName: courierName || orders[index].courierName,
      updatedAt: new Date(),
    };

    console.log(`Order updated: #${orders[index].id} - status: ${orders[index].status}${orders[index].courierName ? ` - courier: ${orders[index].courierName}` : ''}`);

    res.json({
      success: true,
      data: orders[index],
    });
  } catch (error) {
    console.error('Failed to update order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update order',
    });
  }
});

/**
 * DELETE /api/orders/:id
 * Отменить заказ
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const index = orders.findIndex((o) => o.id === id);

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    orders[index].status = 'cancelled';
    orders[index].updatedAt = new Date();

    console.log(`Order cancelled: #${orders[index].id}`);

    res.json({
      success: true,
      data: orders[index],
    });
  } catch (error) {
    console.error('Failed to cancel order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel order',
    });
  }
});

export default router;
