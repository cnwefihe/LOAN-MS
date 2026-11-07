/** Plain wording for audit records, so nobody has to read internal action codes. */
const NAMES: Record<string, string> = {
  "user.signed_in": "Signed in",
  "user.dev_fixture_login": "Signed in (development)",
  "user.provisioned": "First sign-in",
  "user.role_granted": "Role granted",
  "user.role_revoked": "Role removed",
  "session.revoked": "Session revoked",
  "settings.changed": "Setting changed",
  "content.template_updated": "Notification template changed",
  "role.created": "Role added",
  "role.deleted": "Role deleted",
  "role.renamed": "Role details changed",
  "role.permission_granted": "Permission granted",
  "role.permission_revoked": "Permission removed",
  "servicing.run": "Automatic check run",
};

const sentence = (s: string) => {
  const t = s.replace(/[._]/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export const activityName = (action: string) => NAMES[action] ?? sentence(action.replace(/^org\./, "organisation."));
export const areaName = (entityType: string) => sentence(entityType);

export function deviceName(ua: string | null) {
  if (!ua) return "Unknown device";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "Other";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${b} on ${os}`;
}

export const networkName = (ip: string | null) => (!ip ? "Network not recorded" : ip === "::1" || ip === "127.0.0.1" ? "This computer" : `IP address ${ip}`);
