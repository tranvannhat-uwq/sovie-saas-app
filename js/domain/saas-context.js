const MEMBERSHIP_ROLES = new Set(['owner', 'admin', 'accounting', 'sale']);

export function resolveActiveSaasContext(payload) {
  const organizations = Array.isArray(payload?.organizations) ? payload.organizations : [];
  const activeOrganizationId = String(
    payload?.activeOrganizationId || payload?.active_organization_id || ''
  ).trim();
  const activeOrganization = organizations.find(item =>
    String(item?.id || '').trim() === activeOrganizationId
  );

  if (!activeOrganizationId || !activeOrganization) {
    throw new Error('Tài khoản chưa được gắn với doanh nghiệp SaaS hợp lệ.');
  }

  const organizationRole = String(activeOrganization.role || '').trim().toLowerCase();
  if (!MEMBERSHIP_ROLES.has(organizationRole)) {
    throw new Error('Vai trò trong doanh nghiệp SaaS không hợp lệ.');
  }

  return Object.freeze({
    activeOrganizationId,
    organizationId: activeOrganizationId,
    organizationName: String(activeOrganization.name || '').trim(),
    organizationSlug: String(activeOrganization.slug || '').trim(),
    organizationStatus: String(activeOrganization.status || '').trim(),
    organizationRole,
    applicationRole: organizationRole === 'owner' ? 'admin' : organizationRole,
    subscription: activeOrganization.subscription || null,
    organizations
  });
}

export function applyLoginDomainContext(payload, domainBinding) {
  if (domainBinding?.allowed !== true) {
    return { ok: false, reason: 'domain_mismatch' };
  }
  if (domainBinding.platformOnly === true) {
    return { ok: true, platformOnly: true, payload: null };
  }

  const organizations = Array.isArray(payload?.organizations) ? payload.organizations : [];
  const organizationId = String(domainBinding.organizationId || '').trim();
  if (!organizationId) {
    return organizations.length === 0
      ? { ok: true, platformOnly: false, payload }
      : { ok: false, reason: 'domain_mismatch' };
  }

  const activeOrganizationId = String(
    payload?.activeOrganizationId || payload?.active_organization_id || ''
  ).trim();
  if (activeOrganizationId !== organizationId) {
    return { ok: false, reason: 'domain_mismatch' };
  }

  const organization = organizations.find(item => String(item?.id || '').trim() === organizationId);
  if (!organization) return { ok: false, reason: 'domain_mismatch' };

  return {
    ok: true,
    platformOnly: false,
    payload: {
      ...payload,
      organizations: [organization]
    }
  };
}
