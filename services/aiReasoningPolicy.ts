export type ThinkingProfile =
  | 'auto'
  | 'none-needed'
  | 'openai-none'
  | 'claude-disabled'
  | 'deepseek-disabled'
  | 'gemini-budget-zero'
  | 'unsupported'
  | 'unverified';

export type ThinkingStatus = 'verified' | 'not-applicable' | 'unverified' | 'unsupported';

export interface ReasoningProviderConfig {
  id: string;
  type: 'gemini' | 'openai-compatible';
  model: string;
  baseUrl?: string;
  thinkingProfile?: ThinkingProfile;
  thinkingStatus?: ThinkingStatus;
}

export interface ThinkingPolicy {
  profile: ThinkingProfile;
  status: ThinkingStatus;
  canRun: boolean;
  requestPatch: Record<string, unknown>;
  omitTemperature: boolean;
  message: string;
}

export class ThinkingPolicyError extends Error {
  readonly code = 'THINKING_OFF_UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'ThinkingPolicyError';
  }
}

const isCustom = (provider: ReasoningProviderConfig) => provider.id.startsWith('custom_');

const inferProfile = (provider: ReasoningProviderConfig): ThinkingProfile => {
  const modelIdentity = provider.model.toLowerCase();
  if (/\b(?:o1|o3|o4)(?:$|[-_/])|gpt-5-pro|reasoning/.test(modelIdentity)) return 'unsupported';
  if (provider.thinkingProfile && provider.thinkingProfile !== 'auto') return provider.thinkingProfile;
  const identity = `${provider.baseUrl || ''} ${provider.model}`.toLowerCase();
  if (provider.type === 'gemini') {
    return /gemini-2\.5-(?:flash|flash-lite)|robotics-er/i.test(provider.model)
      ? 'gemini-budget-zero'
      : 'unsupported';
  }
  if (/deepseek/.test(identity)) return 'deepseek-disabled';
  if (/claude/.test(identity)) return 'claude-disabled';
  if (/gpt-(?:4|3\.5)|chatgpt-4/.test(identity)) return 'none-needed';
  if (/gpt-5(?:$|[.\-])/.test(identity) && !/gpt-5-pro/.test(identity)) return 'openai-none';
  return 'unverified';
};

const statusFor = (provider: ReasoningProviderConfig, profile: ThinkingProfile): ThinkingStatus => {
  if (profile === 'unsupported') return 'unsupported';
  if (profile === 'unverified') return 'unverified';
  if (profile === 'none-needed') return isCustom(provider)
    ? (provider.thinkingStatus === 'verified' ? 'verified' : 'unverified')
    : 'not-applicable';
  if (!isCustom(provider)) return 'verified';
  return provider.thinkingStatus === 'verified' ? 'verified' : 'unverified';
};

export const resolveThinkingPolicy = (provider: ReasoningProviderConfig): ThinkingPolicy => {
  const profile = inferProfile(provider);
  const status = statusFor(provider, profile);
  const requestPatch: Record<string, unknown> = {};
  let omitTemperature = false;
  let message = 'Thinking đã được tắt.';

  if (profile === 'openai-none') requestPatch.reasoning_effort = 'none';
  if (profile === 'claude-disabled') {
    requestPatch.thinking = { type: 'disabled' };
    omitTemperature = /claude-(?:sonnet|opus)-(?:5|4\.[789])/.test(provider.model.toLowerCase());
  }
  if (profile === 'deepseek-disabled') requestPatch.thinking = { type: 'disabled' };
  if (profile === 'gemini-budget-zero') requestPatch.thinkingConfig = { thinkingBudget: 0 };
  if (profile === 'none-needed') message = 'Model này không dùng reasoning tokens.';
  if (profile === 'unverified') message = 'Chưa xác minh được cách tắt thinking cho API/model này.';
  if (profile === 'unsupported') message = 'Model này không hỗ trợ tắt thinking hoàn toàn. Hãy chọn model khác.';

  return {
    profile,
    status,
    canRun: status === 'verified' || status === 'not-applicable',
    requestPatch,
    omitTemperature,
    message,
  };
};

export interface ThinkingProbeResult {
  status: ThinkingStatus;
  profile: ThinkingProfile;
  message: string;
  checkedAt: number;
}

const endpointFor = (provider: ReasoningProviderConfig): string =>
  `${(provider.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;

/** A small request that verifies the provider accepts the selected thinking-off profile. */
export const probeOpenAIThinkingPolicy = async (
  provider: ReasoningProviderConfig,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ThinkingProbeResult> => {
  const policy = resolveThinkingPolicy({ ...provider, thinkingStatus: 'verified' });
  const checkedAt = Date.now();
  if (provider.type !== 'openai-compatible' || policy.profile === 'unsupported' || policy.profile === 'unverified') {
    return { status: policy.status, profile: policy.profile, message: policy.message, checkedAt };
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Thinking probe timed out', 'TimeoutError')), 20_000);
  try {
  const response = await fetch(endpointFor(provider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: 'user', content: 'Return exactly {"ok":true}.' }],
      stream: false,
      max_tokens: 32,
      ...(policy.omitTemperature ? {} : { temperature: 0 }),
      ...policy.requestPatch,
    }),
    signal: controller.signal,
  });
  const body = await response.text();
  if (!response.ok) {
    return {
      status: 'unsupported',
      profile: policy.profile,
      message: `API từ chối cấu hình tắt thinking (HTTP ${response.status}).`,
      checkedAt,
    };
  }
  try {
    const parsed = JSON.parse(body);
    const reasoningTokens = parsed?.usage?.completion_tokens_details?.reasoning_tokens ?? parsed?.usage?.reasoning_tokens;
    const reasoningContent = parsed?.choices?.[0]?.message?.reasoning_content ?? parsed?.choices?.[0]?.message?.reasoning;
    const content = parsed?.choices?.[0]?.message?.content;
    if ((typeof reasoningTokens === 'number' && reasoningTokens > 0) || reasoningContent) {
      return { status: 'unverified', profile: policy.profile, message: 'API vẫn trả reasoning trong probe.', checkedAt };
    }
    if (typeof content !== 'string' || !/"ok"\s*:\s*true/.test(content)) {
      return { status: 'unverified', profile: policy.profile, message: 'API không trả nội dung probe đầy đủ.', checkedAt };
    }
  } catch {
    return { status: 'unverified', profile: policy.profile, message: 'API không trả JSON hợp lệ cho probe.', checkedAt };
  }
  return { status: policy.status, profile: policy.profile, message: 'API đã chấp nhận cấu hình tắt thinking.', checkedAt };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};
