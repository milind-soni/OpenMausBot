/** Inherited AWS variables that outrank AWS_PROFILE in the AWS SDK's own credential resolution, so a Bedrock
 *  instance never runs on another instance's (or this machine's shell) AWS credentials. */
export const AWS_CREDENTIAL_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_DEFAULT_PROFILE",
] as const;

// AWS credential failures surface from the SDK as plain English, not a structured error code; matched by text.
const BEDROCK_CREDENTIAL_ERROR =
  /\bExpiredToken(?:Exception)?\b|security token included in the request is (?:expired|invalid)|sso session associated with this profile has expired|unable to locate credentials|could not load credentials/i;

/** A plain next step for an AWS profile that can no longer authenticate; null when the text is some other failure. */
export function bedrockCredentialError(text: string, awsProfile: string): string | null {
  if (!BEDROCK_CREDENTIAL_ERROR.test(text)) return null;
  return `AWS credentials for profile ${awsProfile} are missing or expired. If it uses SSO, run \`aws sso login --profile ${awsProfile}\`; otherwise check ~/.aws, then try again.`;
}

/** The turn error to show: the AWS sign-in step when a Bedrock instance's profile failed, else `error` unchanged. */
export function withBedrockCredentialError<T extends { message: string }>(
  bedrock: boolean | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  said: string,
  error: T
): T | { message: string } {
  const awsProfile = bedrock ? environment.AWS_PROFILE : undefined;
  const message = awsProfile ? bedrockCredentialError(said, awsProfile) : null;
  return message ? { message } : error;
}

/** The same choice for a turn's final error text. */
export function bedrockResultError(bedrock: boolean | undefined, environment: Readonly<Record<string, string | undefined>>, message: string): string {
  return withBedrockCredentialError(bedrock, environment, message, { message }).message;
}
