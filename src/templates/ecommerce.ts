import type { Template } from '../types.js';

/**
 * Store data, shaped like a Shopify order export (or any orders/products table).
 *
 * The story this demo tells: revenue moved, and the reason is a specific product,
 * channel, geography or discount decision — not "the market".
 */
export const EcommerceTemplate: Template = {
  id: 'ecommerce',
  name: 'Ecommerce store',
  description:
    'Orders with line items, products, customers, revenue, discounts, refunds and dates. Optimised for questions about revenue changes, product mix, retention and where customers drop out.',
  voice: [
    'You write for the person who owns the store and watches the revenue number every morning.',
    'Be commercial and concrete: name the product, the channel, the cohort and the amount. Explain the cause',
    'in terms of merchandising, pricing, discounts, traffic or retention decisions they control.',
    'Never blame "the market" unless the data shows a drop across every category at once.',
  ].join(' '),
  detectiveHints: [
    'Separate price from volume: a revenue drop is either fewer orders, a smaller basket, or a lower price per unit.',
    'Split by product, category, channel, country and new-versus-returning customer before concluding anything.',
    'Find the biggest absolute contributor to the change, not the biggest percentage — one product can move the total.',
    'Discounts are a common false friend: check whether a promo period explains the change and whether the margin held.',
    'Refunds and cancellations can hide a "successful" month — compare gross and net revenue when both are available.',
    'For retention questions, compute repeat rate by cohort month rather than overall averages.',
  ],
  heroQuestions: [
    'Why did sales drop last month?',
    'Which products actually make the money?',
    'Why do customers buy once and never come back?',
    'Where do I lose customers between cart and checkout?',
  ],
  signals: [
    'order',
    'sku',
    'product',
    'gmv',
    'revenue',
    'price',
    'quantity',
    'cart',
    'checkout',
    'refund',
    'discount',
    'coupon',
    'customer',
    'shopify',
    'fulfillment',
    'shipping',
  ],
  glossary: {
    AOV: 'average order value — total revenue divided by number of orders',
    GMV: 'gross merchandise value — order value before returns and fees',
    'Repeat rate': 'share of customers with more than one order',
    'Refund rate': 'share of order value refunded',
  },
};

export default EcommerceTemplate;
