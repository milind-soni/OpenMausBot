/** Public tool shape; semantic cross-field checks run in normalizeMeetingLimits. */
export const MEETING_LIMITS_SCHEMA = {
  type: "object", additionalProperties: false,
  description: "Any combination; omitted dimensions are off. Omit for 16/22 replies. Wrap defaults to 70%. Tokens include all input/output and private checks; dollars use OpenRouter token rates.",
  properties: {
    replies: { type: "object", additionalProperties: false, properties: {
      hardStop: { type: "integer", minimum: 1, maximum: 100000 }, wrapUpAfter: { type: "integer", minimum: 0 },
    }, required: ["hardStop"] },
    tokens: { type: "object", additionalProperties: false, properties: {
      hardStop: { type: "integer", minimum: 1, maximum: 1000000000 }, wrapUpAt: { type: "integer", minimum: 0 },
      count: { type: "string", enum: ["total"] },
    }, required: ["hardStop"] },
    time: { type: "object", additionalProperties: false, properties: {
      seconds: { type: "integer", minimum: 1, maximum: 604800 }, wrapUpSeconds: { type: "integer", minimum: 0 },
    }, required: ["seconds"] },
    cost: { type: "object", additionalProperties: false, properties: {
      hardStopUsd: { type: "number", minimum: 0, maximum: 100000 }, wrapUpUsd: { type: "number", minimum: 0 },
    }, required: ["hardStopUsd"] },
  },
};
