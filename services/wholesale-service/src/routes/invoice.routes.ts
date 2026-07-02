import { Router, Request, Response } from 'express';
import Joi from 'joi';
import pkg from 'pg';
const { Pool } = pkg;
import { authenticateUser, requireRole, ROLES } from '../middleware/auth.middleware';
import { WholesaleOrderService } from '../services/order.service';
import { generateInvoicePdf, invoiceFileName } from '../services/invoice-pdf.service';
import { config } from '../config';
import { logger } from '../utils/logger';

export function invoiceRoutes(pool: InstanceType<typeof Pool>): Router {
  const router = Router();
  const orders = new WholesaleOrderService(pool);

  const ROLES_ALLOWED = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.OPERATOR];

  async function loadSeller(enterpriseId?: string): Promise<any> {
    if (!enterpriseId) return {};
    const r = await pool.query('SELECT name, legal_name, tax_id, phone FROM enterprises WHERE id = $1', [enterpriseId]);
    const e = r.rows[0];
    return e ? { name: e.name, legalName: e.legal_name, taxId: e.tax_id, phone: e.phone } : {};
  }

  // PDF-накладная по заказу
  router.get('/orders/:id/invoice.pdf', authenticateUser, requireRole(...ROLES_ALLOWED), async (req: Request, res: Response) => {
    try {
      const order = await orders.getById(req.params.id, req.enterpriseId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!order.invoice_number) return res.status(400).json({ error: 'Order has no invoice number — подтвердите заказ' });

      const seller = await loadSeller(order.enterprise_id);
      const pdf = await generateInvoicePdf(order, seller);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(invoiceFileName(order))}`);
      res.send(pdf);
    } catch (err) {
      logger.error('invoice pdf failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Отправка накладной контрагенту в WhatsApp
  router.post('/orders/:id/send-invoice', authenticateUser, requireRole(...ROLES_ALLOWED), async (req: Request, res: Response) => {
    try {
      const schema = Joi.object({
        phone: Joi.string().max(50).optional(),
        message: Joi.string().max(2000).optional()
      });
      const { error, value } = schema.validate(req.body || {});
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });

      const order = await orders.getById(req.params.id, req.enterpriseId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!order.invoice_number) return res.status(400).json({ error: 'Order has no invoice number — подтвердите заказ' });

      const phone = value.phone || order.counterparty_whatsapp || order.counterparty_phone;
      if (!phone) return res.status(400).json({ error: 'У контрагента не указан телефон для WhatsApp' });

      const seller = await loadSeller(order.enterprise_id);
      const pdf = await generateInvoicePdf(order, seller);

      const message = value.message ||
        `Здравствуйте! Накладная ${order.invoice_number} от ${new Date(order.shipped_at || order.created_at).toLocaleDateString('ru-RU')} на сумму ${parseFloat(order.total_amount).toLocaleString('ru-RU')} ₽.`;

      const resp = await fetch(`${config.whatsappServiceUrl}/api/whatsapp/send-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': config.internalToken
        },
        body: JSON.stringify({
          phone,
          message,
          fileBase64: pdf.toString('base64'),
          fileName: invoiceFileName(order)
        })
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        logger.warn(`whatsapp send-file failed: ${resp.status}`, body);
        return res.status(502).json({ error: 'WhatsApp service error', details: body });
      }
      res.json({ success: true, phone, whatsapp: body });
    } catch (err) {
      logger.error('send invoice failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

export default invoiceRoutes;
