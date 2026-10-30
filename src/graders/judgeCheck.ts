// Six examples with known answers, used to test whether a model is a usable judge.
// Three answers are correct (worded differently from the reference) and three are wrong.
export interface JudgeCheckCase {
  label: string;
  input: string;
  expected: string;
  answer: string;
  shouldPass: boolean;
}

const REFUND = 'Refunds are allowed within 7 days of delivery if the item is unused.';
const PASSWORD = "Click 'Forgot password' on the sign-in page.";

export const JUDGE_CHECK_CASES: JudgeCheckCase[] = [
  { label: 'Correct, reworded', input: 'What is the capital of France?', expected: 'Paris', answer: 'The capital city of France is Paris.', shouldPass: true },
  { label: 'Wrong city', input: 'What is the capital of France?', expected: 'Paris', answer: 'The capital of France is Lyon.', shouldPass: false },
  { label: 'Correct, with extra friendly detail', input: 'Can I get a refund?', expected: REFUND, answer: 'Could you share your order ID? Refunds are possible within 7 days of delivery as long as the item is unused.', shouldPass: true },
  { label: 'Wrong policy', input: 'Can I get a refund?', expected: REFUND, answer: 'Refunds are allowed within 30 days, even if the item has been used.', shouldPass: false },
  { label: 'Correct, reworded', input: 'How do I reset my password?', expected: PASSWORD, answer: 'On the sign-in page, choose the Forgot password link.', shouldPass: true },
  { label: 'Wrong instructions', input: 'How do I reset my password?', expected: PASSWORD, answer: 'Please email the support team and wait for a phone call.', shouldPass: false },
];
