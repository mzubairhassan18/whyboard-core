import type { Template } from '../types.js';

/**
 * SaaS metrics: subscriptions, plans, seats, usage, trials and churn.
 * Used by the managed app (whyboard.app) and any SaaS connecting its own DB.
 */
export const SaaSTemplate: Template = {
  id: 'saas',
  name: 'SaaS product',
  description:
    'Accounts, subscriptions, plans, seats, usage events and churn dates. Optimised for questions about MRR movement, churn causes, trial conversion and expansion.',
  voice: [
    'You write for a founder running a SaaS business who thinks in MRR, churn and cohorts.',
    'Be precise about which movement you are explaining: new, expansion, contraction or churn — they have completely',
    'different causes and fixes. Name the plan, cohort and segment responsible.',
  ].join(' '),
  detectiveHints: [
    'Decompose an MRR change into new, expansion, contraction and churn before looking for causes.',
    'For churn questions, compare churned accounts against retained ones on the dimensions you have: plan, seats, tenure, activation, usage in the first 14 days.',
    'Early-life churn and late-life churn have different drivers — split by tenure bucket.',
    'Trial conversion is usually a funnel question: how far do trials get before they stop?',
    'Check whether a plan change (pricing, limits) lines up with the change in conversions or churn.',
  ],
  heroQuestions: [
    'Why did MRR drop this month?',
    'Why are customers churning?',
    'Why do free trials not convert to paid?',
    'Which plan upgrade actually grows revenue?',
  ],
  signals: [
    'subscription',
    'mrr',
    'arr',
    'plan',
    'seat',
    'workspace',
    'account',
    'trial',
    'churn',
    'upgrade',
    'downgrade',
    'invoice',
    'billing',
    'activation',
  ],
  glossary: {
    MRR: 'monthly recurring revenue',
    Churn: 'revenue or customers lost in a period',
    Expansion: 'extra revenue from existing customers, e.g. seat growth or upgrades',
    Activation: 'the action a new account must take before it is likely to stay',
  },
};

export default SaaSTemplate;
