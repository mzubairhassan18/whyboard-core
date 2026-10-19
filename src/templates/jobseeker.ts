import type { Template } from '../types.js';

/**
 * Your own job search, turned into an analytics model.
 *
 * The story this demo tells: 291 applications, 70% rejected, and the reason is
 * almost never "you are not good enough" — it is a mix of channel, timing and
 * role fit that the numbers can actually show.
 */
export const JobSeekerTemplate: Template = {
  id: 'jobseeker',
  name: 'Job seeker',
  description:
    'An application tracker: every application, its stage, company, role, source and dates. Optimised for questions about rejection rates, channel quality and funnel drop-off.',
  voice: [
    'You are writing for the person who sent these applications. Speak directly to them as "you" —',
    'their own search, in plain language, with no corporate distance. Be honest about what the numbers say,',
    'including when the cause is the channel or the role rather than their ability, and be specific about what',
    'to change next. Never sound like a recruitment report.',
  ].join(' '),
  detectiveHints: [
    'The headline metric is usually the rejection rate at each funnel stage (applied → screen → interview → offer), not the total.',
    'Compare groups: source channel (LinkedIn, referral, job board, cold email), role family, seniority, company size, and whether the application was referred.',
    'A channel with few applications but a high interview rate is the story — quantify the lift versus the biggest channel.',
    'Check response time (days to first reply) and whether "no reply at all" is being counted as a rejection; ghosting and rejection are different answers.',
    'Look for the counterfactual: what would the overall rate be if all applications came from the best-performing channel?',
    'Beware small samples: never quote a rate from fewer than 10 applications without saying how small it is.',
  ],
  heroQuestions: [
    'Why am I getting rejected so often?',
    'Which application channel actually gets me interviews?',
    'What separates the applications that reached an interview from the ones that did not?',
    'Am I applying to the wrong roles, or applying the wrong way?',
  ],
  signals: [
    'application',
    'applicant',
    'applied',
    'resume',
    'cv',
    'interview',
    'reject',
    'rejected',
    'offer',
    'recruiter',
    'hiring',
    'candidate',
    'job_title',
    'stage',
  ],
  glossary: {
    ATS: 'applicant tracking system — software that filters applications before a human sees them',
    Ghosted: 'no reply at all, as opposed to an explicit rejection',
    Referral: 'an application where an employee passed your CV on internally',
    Funnel: 'the stages an application passes through: applied → screen → interview → offer',
  },
};

export default JobSeekerTemplate;
