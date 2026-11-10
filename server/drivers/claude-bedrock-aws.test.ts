import { describe, expect, it } from "vitest";

import { bedrockCredentialError, bedrockResultError, withBedrockCredentialError } from "./claude-bedrock-aws.ts";

describe("bedrockCredentialError", () => {
  it("turns a few representative AWS SDK credential failures into one plain next step", () => {
    for (const text of [
      "ExpiredToken: The security token included in the request is expired",
      "UnrecognizedClientException: The security token included in the request is invalid",
      "ExpiredTokenException: the SSO session associated with this profile has expired or is otherwise invalid",
      "Unable to locate credentials. You can configure credentials by running \"aws configure\".",
      "Could not load credentials from any providers",
      "API Error: Could not load AWS credentials · Could not load credentials from any providers. Check or refresh your AWS credentials and try again.",
    ]) {
      expect(bedrockCredentialError(text, "bedrock-prod")).toBe(
        "AWS credentials for profile bedrock-prod are missing or expired. If it uses SSO, run `aws sso login --profile bedrock-prod`; otherwise check ~/.aws, then try again."
      );
    }
  });

  it("leaves an unrelated failure alone", () => {
    for (const text of [
      "ValidationException: The model is not supported in this region",
      "Claude ended the turn with an error (unknown).",
      "",
    ]) {
      expect(bedrockCredentialError(text, "bedrock-prod")).toBeNull();
    }
  });
});

describe("withBedrockCredentialError", () => {
  const expired = "API Error: Could not load AWS credentials · Could not load credentials from any providers.";
  const env = { AWS_PROFILE: "bedrock-prod" };

  it("replaces a credential failure on a Bedrock instance with the sign-in step", () => {
    expect(withBedrockCredentialError(true, env, expired, { message: expired, text: { key: "x" } })).toEqual({
      message: "AWS credentials for profile bedrock-prod are missing or expired. If it uses SSO, run `aws sso login --profile bedrock-prod`; otherwise check ~/.aws, then try again.",
    });
    expect(bedrockResultError(true, env, expired)).toContain("aws sso login --profile bedrock-prod");
  });

  it("keeps the original error off Bedrock, without a profile, or for another failure", () => {
    const error = { message: expired };
    expect(withBedrockCredentialError(undefined, env, expired, error)).toBe(error);
    expect(withBedrockCredentialError(true, {}, expired, error)).toBe(error);
    expect(bedrockResultError(true, env, "ValidationException: bad model")).toBe("ValidationException: bad model");
  });
});
