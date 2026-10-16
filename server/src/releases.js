"use strict";
const COMPONENTS = ["backend", "admin", "staff", "employee"];
const ACTIVE = ["queued", "deploying", "verifying", "interrupted"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}
function cleanRelease(input) {
  if (
    typeof input.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(input.version)
  )
    fail("Use a release version of 1–50 letters, numbers, dots or hyphens.");
  if (
    typeof input.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.commitSha)
  )
    fail("Enter the full 40-character lowercase commit SHA.");
  if (
    typeof input.notes !== "string" ||
    !input.notes.trim() ||
    input.notes.length > 12000
  )
    fail("Release notes are required (up to 12,000 characters).");
  let tabletBundle = null;
  if (input.tabletBundle) {
    const b = input.tabletBundle;
    if (
      !/^[a-zA-Z0-9._-]{1,150}$/.test(b.appId || "") ||
      !/^[a-zA-Z0-9._-]{1,50}$/.test(b.channel || "") ||
      !/^[a-zA-Z0-9._-]{1,50}$/.test(b.version || "") ||
      !/^[a-f0-9]{64}$/.test(b.checksum || "")
    )
      fail(
        "Tablet bundle needs its app ID, channel, version and SHA-256 checksum.",
      );
    tabletBundle = {
      appId: b.appId,
      channel: b.channel,
      version: b.version,
      checksum: b.checksum,
    };
  }
  return {
    version: input.version,
    commitSha: input.commitSha,
    notes: input.notes.trim(),
    tabletBundle,
  };
}
function cleanTarget(input) {
  if (
    !UUID.test(input.projectId || "") ||
    !UUID.test(input.environmentId || "")
  )
    fail("Railway project and environment IDs must be UUIDs.");
  if (input.autoDeployDisabled !== true)
    fail(
      "Disable automatic deployments on every production service before enabling Console releases.",
    );
  const services = {};
  for (const component of COMPONENTS) {
    if (
      ["staff", "employee"].includes(component) &&
      !input.services?.[component]
    )
      continue;
    if (!UUID.test(input.services?.[component] || ""))
      fail(`A valid ${component} service ID is required.`);
    services[component] = input.services[component];
  }
  if (new Set(Object.values(services)).size !== Object.keys(services).length)
    fail("Each component needs a different Railway service.");
  if (
    input.railwayToken &&
    (typeof input.railwayToken !== "string" ||
      input.railwayToken.length < 20 ||
      input.railwayToken.length > 512 ||
      /\s/.test(input.railwayToken))
  )
    fail("Enter a valid Railway project token.");
  return {
    projectId: input.projectId,
    environmentId: input.environmentId,
    services,
    autoDeployDisabled: true,
  };
}
function cleanApproval(input, now = Date.now()) {
  if (!Number.isSafeInteger(input.releaseId) || input.releaseId < 1)
    fail("Choose a release.");
  if (
    !Array.isArray(input.venueIds) ||
    !input.venueIds.length ||
    input.venueIds.length > 200 ||
    input.venueIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(input.venueIds).size !== input.venueIds.length
  )
    fail("Select between 1 and 200 different venues.");
  const scheduledAt = input.scheduledAt
    ? new Date(input.scheduledAt)
    : new Date(now);
  if (
    !Number.isFinite(scheduledAt.getTime()) ||
    (input.scheduledAt && scheduledAt.getTime() < now - 60000) ||
    scheduledAt.getTime() > now + 90 * 86400000
  )
    fail("Schedule the release within the next 90 days.");
  return {
    releaseId: input.releaseId,
    venueIds: [...input.venueIds].sort((a, b) => a - b),
    scheduledAt,
  };
}
function assertEligible(venue, target, active) {
  if (venue.status !== "active")
    fail(`${venue.name} is suspended or offboarded.`);
  if (!target) fail(`${venue.name} needs deployment setup first.`);
  if (
    !venue.api_url ||
    !venue.admin_url ||
    (target.services.staff && !venue.staff_url) ||
    (target.services.employee && !target.employee_url)
  )
    fail(`${venue.name} needs URLs for all deployed portals.`);
  if (active) fail(`${venue.name} already has an update queued or running.`);
}
module.exports = {
  COMPONENTS,
  ACTIVE,
  cleanRelease,
  cleanTarget,
  cleanApproval,
  assertEligible,
};
