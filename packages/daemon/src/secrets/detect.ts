/** Does a task text look like it carries plaintext credentials or account data? Cheap and deliberately broad:
 *  a hit only means the sealer (a model) gets to look; a miss means the text is sent as is. */

const CUES = [
  /密码|口令|密钥|令牌|验证码|账号|帐号|用户名|登录名/,
  /\b(password|passwd|pwd|passcode|secret|token|api[ _-]?key|access[ _-]?key|otp|totp|2fa|credential|login|username|user ?name)\b/i,
  /\b(pass|pw|token|key|secret)\s*[:=]\s*\S{4,}/i,
];

export function looksSensitive(text: string): boolean {
  return CUES.some((re) => re.test(text));
}
