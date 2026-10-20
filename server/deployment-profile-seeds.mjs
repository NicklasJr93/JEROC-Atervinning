/** The owner explicitly requested this missing profile address for this
 * existing Render installation. Never use it as a default for other SaaS
 * deployments, local fixtures, company owners or newly created tenant users.
 * Auth applies the named seed at most once, only to the matching empty profile.
 */
export function initialAdminProfileForDeployment(env = process.env) {
  if (env.RENDER_SERVICE_ID !== 'srv-dbba71yf3r2c7384cm7g'
    || env.SCRAPPLANNER_DEPLOYMENT_MODE !== 'pilot'
    || env.APP_URL !== 'https://app.scrapplanner.com') return undefined;
  return { id: 'platform-admin', email: 'nicklas@endorgroup.se', seedId: 'scrapplanner-live-admin-profile-2026-10-20' };
}
