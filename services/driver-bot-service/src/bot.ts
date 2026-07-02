import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import {
  DriverUser,
  findDriverByPhone,
  findUserByChatId,
  getDayStats,
  linkChat
} from './db';
import {
  AuthCtx,
  WholesaleApiError,
  WholesaleOrder,
  confirmReturn,
  createReturn,
  deliverOrder,
  getOrder,
  listShippedOrders,
  payOrder
} from './wholesale-api';
import { fmtMoney, fmtQty, num, orderCard, orderTitle } from './format';
import {
  AvailableReturnItem,
  ReturnItemDraft,
  SessionState,
  sessions
} from './state';
import { logger } from './utils/logger';

const MENU = {
  deliveries: '🚚 Мои доставки',
  myDay: '📊 Мой день',
  help: '❓ Помощь'
} as const;

export const mainMenuKeyboard = Markup.keyboard([
  [MENU.deliveries],
  [MENU.myDay, MENU.help]
]).resize();

const contactKeyboard = Markup.keyboard([
  [Markup.button.contactRequest('📱 Отправить мой номер')]
])
  .resize()
  .oneTime();

function authOf(user: DriverUser): AuthCtx {
  return { userId: user.id, enterpriseId: user.enterprise_id };
}

/** Кнопки под карточкой заказа */
export function orderButtons(orderId: string, opts: { delivered?: boolean } = {}) {
  const rows = [];
  if (!opts.delivered) {
    rows.push([Markup.button.callback('✅ Доставлено', `deliver:${orderId}`)]);
  }
  rows.push([
    Markup.button.callback('💰 Оплата', `pay:${orderId}`),
    Markup.button.callback('↩️ Возврат', `ret:${orderId}`)
  ]);
  return Markup.inlineKeyboard(rows);
}

async function requireLinkedUser(ctx: Context): Promise<DriverUser | null> {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;
  const user = await findUserByChatId(chatId);
  if (!user) {
    await ctx.reply(
      'Вы не авторизованы. Отправьте свой номер телефона, чтобы продолжить.',
      contactKeyboard
    );
    return null;
  }
  return user;
}

async function handleError(ctx: Context, e: unknown): Promise<void> {
  if (e instanceof WholesaleApiError) {
    logger.warn(`wholesale API error: ${e.message} (HTTP ${e.status})`);
    await ctx.reply(`⚠️ ${e.message}`).catch(() => undefined);
    return;
  }
  logger.error('bot handler error', e);
  await ctx.reply('⚠️ Произошла ошибка, попробуйте позже.').catch(() => undefined);
}

/** max к возврату по каждой позиции с учётом уже добавленных в текущую сессию */
function buildAvailableItems(
  order: WholesaleOrder,
  drafts: ReturnItemDraft[]
): AvailableReturnItem[] {
  const added = new Map<string, number>();
  for (const d of drafts) {
    added.set(d.orderItemId, (added.get(d.orderItemId) || 0) + d.quantity);
  }
  const result: AvailableReturnItem[] = [];
  for (const it of order.items || []) {
    const base =
      it.shipped_quantity !== null && it.shipped_quantity !== undefined
        ? num(it.shipped_quantity)
        : num(it.quantity);
    const max =
      Math.round((base - num(it.returned_quantity) - (added.get(it.id) || 0)) * 1000) / 1000;
    if (max > 0) {
      result.push({ id: it.id, name: it.name, unit: it.unit, max });
    }
  }
  return result;
}

function pickItemKeyboard(state: Extract<SessionState, { type: 'return' }>) {
  const rows = state.availableItems.map((it, i) => [
    Markup.button.callback(
      `${it.name} (ост. ${fmtQty(it.max)} ${it.unit || 'шт'})`,
      `reti:${i}`
    )
  ]);
  if (state.items.length > 0) {
    rows.push([Markup.button.callback('✅ Готово', 'retdone')]);
  }
  rows.push([Markup.button.callback('❌ Отмена', 'retcancel')]);
  return Markup.inlineKeyboard(rows);
}

const moreOrDoneKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Добавить ещё позицию', 'retadd')],
  [Markup.button.callback('✅ Готово', 'retdone')],
  [Markup.button.callback('❌ Отмена', 'retcancel')]
]);

/** Позиция возврата собрана (кол-во + куда + причина) — предлагаем добавить ещё или завершить */
async function finalizeReturnItem(
  ctx: Context,
  chatId: number,
  state: Extract<SessionState, { type: 'return' }>,
  reason?: string
): Promise<void> {
  const cur = state.current;
  if (!cur || cur.quantity === undefined || !cur.disposition) return;
  state.items.push({
    orderItemId: cur.orderItemId,
    name: cur.name,
    unit: cur.unit,
    quantity: cur.quantity,
    disposition: cur.disposition,
    reason: reason || undefined
  });
  state.current = undefined;
  state.stage = 'more';
  sessions.set(chatId, state);

  const summary = state.items
    .map(
      (it) =>
        `— ${it.name} × ${fmtQty(it.quantity)} ${it.unit || 'шт'} (${
          it.disposition === 'restock' ? 'на склад' : 'списание'
        })`
    )
    .join('\n');
  await ctx.reply(
    `Позиция добавлена.\n\nВозврат по ${state.invoiceNumber || 'заказу'}:\n${summary}\n\nДобавить ещё позицию или оформить?`,
    moreOrDoneKeyboard
  );
}

async function submitPayment(
  ctx: Context,
  chatId: number,
  user: DriverUser,
  orderId: string,
  invoiceNumber: string | null,
  amount: number
): Promise<void> {
  const result = await payOrder(authOf(user), orderId, amount);
  sessions.delete(chatId);
  let debtLine = '';
  if (result.order) {
    const debt =
      Math.round((num(result.order.total_amount) - num(result.order.paid_amount)) * 100) / 100;
    debtLine = debt > 0 ? `\nОстаток долга: ${fmtMoney(debt)}` : '\nЗаказ оплачен полностью ✅';
  }
  await ctx.reply(
    `💰 Принято ${fmtMoney(amount)} наличными по ${invoiceNumber || 'заказу'}.${debtLine}`,
    mainMenuKeyboard
  );
}

export function registerBotHandlers(bot: Telegraf): void {
  // --- /start ---
  bot.start(async (ctx) => {
    try {
      sessions.delete(ctx.chat.id);
      const user = await findUserByChatId(ctx.chat.id);
      if (user) {
        await ctx.reply(
          `Здравствуйте, ${user.first_name}! Вы уже авторизованы как водитель.`,
          mainMenuKeyboard
        );
        return;
      }
      await ctx.reply(
        'Здравствуйте! Это бот для водителей доставки.\n' +
          'Чтобы войти, отправьте свой номер телефона кнопкой ниже.',
        contactKeyboard
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Привязка по контакту ---
  bot.on(message('contact'), async (ctx) => {
    try {
      const contact = ctx.message.contact;
      const phone = (contact.phone_number || '').trim();
      const user = await findDriverByPhone(phone);
      if (!user) {
        await ctx.reply('Номер не найден. Обратитесь к менеджеру.');
        return;
      }
      await linkChat(user.id, ctx.chat.id);
      logger.info(`Linked chat ${ctx.chat.id} to user ${user.id} (${user.role})`);
      await ctx.reply(
        `✅ Добро пожаловать, ${user.first_name} ${user.last_name}!\n` +
          'Теперь вам будут приходить уведомления о назначенных доставках.',
        mainMenuKeyboard
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Меню: Мои доставки ---
  bot.hears(MENU.deliveries, async (ctx) => {
    try {
      sessions.delete(ctx.chat.id);
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const auth = authOf(user);
      const orders = await listShippedOrders(auth);
      if (orders.length === 0) {
        await ctx.reply('Активных доставок нет 👍', mainMenuKeyboard);
        return;
      }
      await ctx.reply(`Доставок в работе: ${orders.length}`);
      for (const o of orders) {
        // подтягиваем состав для карточки
        let full = o;
        try {
          full = await getOrder(auth, o.id);
        } catch (e) {
          logger.warn(`failed to load order details ${o.id}`, e);
        }
        await ctx.reply(orderCard(full), orderButtons(o.id));
      }
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Меню: Мой день ---
  bot.hears(MENU.myDay, async (ctx) => {
    try {
      sessions.delete(ctx.chat.id);
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const s = await getDayStats(user.id);
      await ctx.reply(
        '📊 Мой день:\n' +
          `🚚 Доставлено заказов: ${s.delivered}\n` +
          `💰 Наличных собрано: ${fmtMoney(s.cashCollected)}\n` +
          `↩️ Возвратов принято: ${s.returnsCount}` +
          (s.returnsCount > 0 ? ` на ${fmtMoney(s.returnsAmount)}` : ''),
        mainMenuKeyboard
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Меню: Помощь ---
  bot.hears(MENU.help, async (ctx) => {
    sessions.delete(ctx.chat.id);
    await ctx.reply(
      '❓ Помощь:\n\n' +
        '🚚 Мои доставки — список назначенных вам заказов.\n' +
        '✅ Доставлено — отметить заказ доставленным.\n' +
        '💰 Оплата — принять наличные от клиента.\n' +
        '↩️ Возврат — оформить возврат товара (на склад или списание).\n' +
        '📊 Мой день — доставки, собранные наличные и возвраты за сегодня.\n\n' +
        'По вопросам обращайтесь к менеджеру.',
      mainMenuKeyboard
    );
  });

  // --- ✅ Доставлено ---
  bot.action(/^deliver:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const orderId = ctx.match[1];
      const order = await deliverOrder(authOf(user), orderId);
      const origText = (ctx.callbackQuery.message as { text?: string } | undefined)?.text;
      const doneText = `${origText || `Накладная ${orderTitle(order)}`}\n\n✅ Доставлено`;
      try {
        await ctx.editMessageText(doneText, orderButtons(orderId, { delivered: true }));
      } catch {
        await ctx.reply(`✅ ${orderTitle(order)} — доставлено`);
      }
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- 💰 Оплата: запрос суммы ---
  bot.action(/^pay:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const orderId = ctx.match[1];
      const order = await getOrder(authOf(user), orderId);
      const remaining =
        Math.round((num(order.total_amount) - num(order.paid_amount)) * 100) / 100;
      if (remaining <= 0) {
        await ctx.reply(`Заказ ${orderTitle(order)} уже оплачен полностью ✅`);
        return;
      }
      sessions.set(ctx.chat!.id, {
        type: 'pay_amount',
        orderId,
        invoiceNumber: order.invoice_number,
        remaining
      });
      await ctx.reply(
        `💰 Оплата по ${orderTitle(order)}.\nДолг: ${fmtMoney(remaining)}.\n` +
          'Введите сумму наличных или нажмите кнопку:',
        Markup.inlineKeyboard([
          [Markup.button.callback(`💵 Всю сумму (${fmtMoney(remaining)})`, `payfull:${orderId}`)],
          [Markup.button.callback('❌ Отмена', 'paycancel')]
        ])
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- 💰 Оплата: вся сумма ---
  bot.action(/^payfull:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const orderId = ctx.match[1];
      const chatId = ctx.chat!.id;
      const state = sessions.get(chatId);
      let remaining: number;
      let invoiceNumber: string | null;
      if (state && state.type === 'pay_amount' && state.orderId === orderId) {
        remaining = state.remaining;
        invoiceNumber = state.invoiceNumber;
      } else {
        const order = await getOrder(authOf(user), orderId);
        remaining = Math.round((num(order.total_amount) - num(order.paid_amount)) * 100) / 100;
        invoiceNumber = order.invoice_number;
      }
      if (remaining <= 0) {
        sessions.delete(chatId);
        await ctx.reply('Заказ уже оплачен полностью ✅');
        return;
      }
      await submitPayment(ctx, chatId, user, orderId, invoiceNumber, remaining);
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  bot.action('paycancel', async (ctx) => {
    await ctx.answerCbQuery();
    sessions.delete(ctx.chat!.id);
    await ctx.reply('Оплата отменена.', mainMenuKeyboard);
  });

  // --- ↩️ Возврат: выбор позиции ---
  bot.action(/^ret:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const orderId = ctx.match[1];
      const order = await getOrder(authOf(user), orderId);
      const availableItems = buildAvailableItems(order, []);
      if (availableItems.length === 0) {
        await ctx.reply('По этому заказу нет позиций, доступных к возврату.');
        return;
      }
      const state: SessionState = {
        type: 'return',
        orderId,
        invoiceNumber: order.invoice_number,
        stage: 'pick_item',
        availableItems,
        items: []
      };
      sessions.set(ctx.chat!.id, state);
      await ctx.reply(
        `↩️ Возврат по ${orderTitle(order)}.\nВыберите позицию:`,
        pickItemKeyboard(state)
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Возврат: позиция выбрана → спрашиваем количество ---
  bot.action(/^reti:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const state = sessions.get(chatId);
      if (!state || state.type !== 'return') {
        await ctx.reply('Сессия возврата не найдена. Откройте заказ заново.');
        return;
      }
      const idx = parseInt(ctx.match[1], 10);
      const item = state.availableItems[idx];
      if (!item) {
        await ctx.reply('Позиция не найдена, выберите ещё раз.', pickItemKeyboard(state));
        return;
      }
      state.current = {
        orderItemId: item.id,
        name: item.name,
        unit: item.unit,
        max: item.max
      };
      state.stage = 'quantity';
      sessions.set(chatId, state);
      await ctx.reply(
        `${item.name}: сколько вернуть? (макс. ${fmtQty(item.max)} ${item.unit || 'шт'})\n` +
          'Введите число:'
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Возврат: куда (склад / списание) ---
  bot.action(/^retd:(restock|write_off)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const state = sessions.get(chatId);
      if (!state || state.type !== 'return' || state.stage !== 'disposition' || !state.current) {
        await ctx.reply('Сессия возврата не найдена. Откройте заказ заново.');
        return;
      }
      state.current.disposition = ctx.match[1] as 'restock' | 'write_off';
      state.stage = 'reason';
      sessions.set(chatId, state);
      await ctx.reply(
        'Укажите причину возврата (текстом) или пропустите:',
        Markup.inlineKeyboard([[Markup.button.callback('⏭ Пропустить', 'retskip')]])
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Возврат: пропустить причину ---
  bot.action('retskip', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const chatId = ctx.chat!.id;
      const state = sessions.get(chatId);
      if (!state || state.type !== 'return' || state.stage !== 'reason') return;
      await finalizeReturnItem(ctx, chatId, state);
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Возврат: добавить ещё позицию ---
  bot.action('retadd', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const chatId = ctx.chat!.id;
      const state = sessions.get(chatId);
      if (!state || state.type !== 'return') return;
      // пересчитываем остатки с учётом уже добавленных позиций
      const order = await getOrder(authOf(user), state.orderId);
      state.availableItems = buildAvailableItems(order, state.items);
      if (state.availableItems.length === 0) {
        await ctx.reply('Больше нет позиций для возврата. Нажмите «Готово».', moreOrDoneKeyboard);
        return;
      }
      state.stage = 'pick_item';
      state.current = undefined;
      sessions.set(chatId, state);
      await ctx.reply('Выберите позицию:', pickItemKeyboard(state));
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Возврат: оформить (create + confirm) ---
  bot.action('retdone', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await requireLinkedUser(ctx);
      if (!user) return;
      const chatId = ctx.chat!.id;
      const state = sessions.get(chatId);
      if (!state || state.type !== 'return' || state.items.length === 0) {
        await ctx.reply('Нет добавленных позиций для возврата.');
        return;
      }
      const auth = authOf(user);
      const draft = await createReturn(
        auth,
        state.orderId,
        state.items.map((it) => ({
          orderItemId: it.orderItemId,
          quantity: it.quantity,
          disposition: it.disposition,
          reason: it.reason
        })),
        state.items.map((it) => it.reason).filter(Boolean).join('; ') || undefined
      );
      const confirmed = await confirmReturn(auth, draft.id);
      sessions.delete(chatId);
      await ctx.reply(
        `↩️ Возврат ${confirmed.return_number || draft.return_number || ''} оформлен на сумму ${fmtMoney(
          confirmed.total_amount
        )}.`,
        mainMenuKeyboard
      );
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  // --- Возврат: отмена ---
  bot.action('retcancel', async (ctx) => {
    await ctx.answerCbQuery();
    sessions.delete(ctx.chat!.id);
    await ctx.reply('Возврат отменён.', mainMenuKeyboard);
  });

  // --- Текстовый ввод (сумма оплаты / количество / причина возврата) ---
  bot.on(message('text'), async (ctx) => {
    try {
      const chatId = ctx.chat.id;
      const state = sessions.get(chatId);
      const text = ctx.message.text.trim();

      if (!state) {
        await ctx.reply('Выберите действие в меню 👇', mainMenuKeyboard);
        return;
      }

      // Сумма оплаты
      if (state.type === 'pay_amount') {
        const user = await requireLinkedUser(ctx);
        if (!user) return;
        const amount = parseFloat(text.replace(',', '.').replace(/\s/g, ''));
        if (!Number.isFinite(amount) || amount <= 0) {
          await ctx.reply('Введите корректную сумму, например: 1500 или 1500,50');
          return;
        }
        if (amount > state.remaining + 0.009) {
          await ctx.reply(
            `Сумма больше долга (${fmtMoney(state.remaining)}). Введите сумму не выше долга.`
          );
          return;
        }
        await submitPayment(ctx, chatId, user, state.orderId, state.invoiceNumber, amount);
        return;
      }

      // Возврат: количество
      if (state.type === 'return' && state.stage === 'quantity' && state.current) {
        const qty = parseFloat(text.replace(',', '.').replace(/\s/g, ''));
        if (!Number.isFinite(qty) || qty <= 0) {
          await ctx.reply('Введите корректное количество, например: 2 или 1,5');
          return;
        }
        if (qty > state.current.max + 0.0009) {
          await ctx.reply(
            `Максимум к возврату: ${fmtQty(state.current.max)} ${state.current.unit || 'шт'}. Введите меньшее количество.`
          );
          return;
        }
        state.current.quantity = qty;
        state.stage = 'disposition';
        sessions.set(chatId, state);
        await ctx.reply(
          'Куда оформить возврат?',
          Markup.inlineKeyboard([
            [Markup.button.callback('🗑 Списать (просрочка/порча)', 'retd:write_off')],
            [Markup.button.callback('↩️ Вернуть на склад', 'retd:restock')]
          ])
        );
        return;
      }

      // Возврат: причина
      if (state.type === 'return' && state.stage === 'reason' && state.current) {
        await finalizeReturnItem(ctx, chatId, state, text);
        return;
      }

      await ctx.reply('Выберите действие в меню 👇', mainMenuKeyboard);
    } catch (e) {
      await handleError(ctx, e);
    }
  });

  bot.catch((err, ctx) => {
    logger.error(`Unhandled bot error for update ${ctx.update.update_id}`, err);
  });
}
