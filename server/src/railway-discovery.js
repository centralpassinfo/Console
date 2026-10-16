'use strict';
const ROOTS = {
  backend: 'backend',
  admin: 'admin-portal',
  staff: 'staff-dashboard',
  employee: 'employee-portal',
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
function failure(message, status = 424) {
  return Object.assign(new Error(message), { status });
}
async function railwayQuery(
  token,
  query,
  variables = {},
  fetcher = fetch,
  tokenKind = 'project',
) {
  const operation =
    /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] || 'Discovery';
  let response;
  try {
    response = await fetcher(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        ...(tokenKind === 'setup'
          ? { Authorization: `Bearer ${token}` }
          : { 'Project-Access-Token': token }),
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw Object.assign(
      failure('Railway could not be reached. Try connecting again.'),
      { operation, code: 'RAILWAY_UNAVAILABLE' },
    );
  }
  const denied = () =>
    Object.assign(
      failure(
        tokenKind === 'setup'
          ? 'Railway rejected setup access. Use a workspace token with permission to manage this venue’s project.'
          : 'Railway rejected this project token. Use a token for this venue’s production environment.',
        403,
      ),
      { code: 'RAILWAY_ACCESS_DENIED', operation },
    );
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw denied();
    throw Object.assign(
      failure(
        'Railway could not complete this setup request. Try again after checking Railway availability.',
      ),
      { code: 'RAILWAY_PROVIDER_ERROR', operation },
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(
      failure(
        'Railway returned unreadable service information. Try connecting again.',
      ),
      { operation, code: 'RAILWAY_PROVIDER_ERROR' },
    );
  }
  if (payload?.errors?.length || !payload?.data) {
    if (
      payload?.errors?.some(
        (e) =>
          /UNAUTHENTICATED|FORBIDDEN|UNAUTHORIZED/i.test(
            e.extensions?.code || '',
          ) ||
          /not authori[sz]ed|unauthori[sz]ed|permission|access denied|project.token/i.test(
            e.message || '',
          ),
      )
    )
      throw denied();
    throw Object.assign(
      failure(
        tokenKind === 'setup'
          ? 'Railway could not apply or verify service settings. Check that the setup token can manage this project, then reconnect.'
          : 'Railway could not read this project. Check the project token and its environment access.',
      ),
      { code: 'RAILWAY_PROVIDER_ERROR', operation },
    );
  }
  return payload.data;
}
function host(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}
function root(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}
function proposeServices(services, venue = {}) {
  const selected = {},
    used = new Set();
  for (const [role, folder] of Object.entries(ROOTS)) {
    const expected = host(
      venue[
        {
          backend: 'api_url',
          admin: 'admin_url',
          staff: 'staff_url',
          employee: 'employee_url',
        }[role]
      ],
    );
    const scored = services
      .filter((s) => !used.has(s.id) && !s.image)
      .map((s) => {
        let score = root(s.rootDirectory) === folder ? 100 : 0;
        if (expected && s.urls.some((url) => host(url) === expected))
          score += 200;
        const name = s.name.toLowerCase().replace(/[ _]/g, '-');
        if (
          name === folder ||
          name === role ||
          (role === 'backend' && name === 'api') ||
          (role === 'employee' && ['team', 'team-portal'].includes(name))
        )
          score += 50;
        return { s, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored[0] && (!scored[1] || scored[0].score > scored[1].score)) {
      selected[role] = scored[0].s.id;
      used.add(selected[role]);
    } else selected[role] = '';
  }
  return selected;
}
async function discoverRailway(token, venue = {}, fetcher = fetch) {
  if (
    typeof token !== 'string' ||
    token.length < 20 ||
    token.length > 512 ||
    /\s/.test(token)
  )
    throw failure('Paste this venue’s Railway project token.', 400);
  const { projectToken } = await railwayQuery(
    token,
    'query { projectToken { projectId environmentId project { name workspaceId } environment { name } } }',
    {},
    fetcher,
  );
  if (
    !UUID.test(projectToken?.projectId || '') ||
    !UUID.test(projectToken?.environmentId || '')
  )
    throw failure(
      'Use a Railway project token scoped to this venue’s production environment.',
      400,
    );
  const variables = {
    projectId: projectToken.projectId,
    environmentId: projectToken.environmentId,
  };
  let instances = [],
    after = null;
  do {
    const { environment } = await railwayQuery(
      token,
      `query Discovery($projectId:String!,$environmentId:String!,$after:String) {
      environment(id:$environmentId,projectId:$projectId) { serviceInstances(first:100,after:$after) {
        edges { node { serviceId serviceName rootDirectory source { image } domains { customDomains { domain } serviceDomains { domain } } } }
        pageInfo { hasNextPage endCursor }
      } }
    }`,
      { ...variables, after },
      fetcher,
    );
    const page = environment?.serviceInstances;
    if (!page) throw failure('No service information was returned by Railway.');
    instances.push(...page.edges.map((e) => e.node));
    if (instances.length > 500)
      throw failure('This project has too many services for automatic setup.');
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (page.pageInfo.hasNextPage && !after)
      throw failure('Railway returned an incomplete service list.');
  } while (after);
  const services = instances.map((s) => ({
    id: s.serviceId,
    name: s.serviceName,
    rootDirectory: s.rootDirectory || '',
    image: s.source?.image || null,
    urls: [
      ...(s.domains?.customDomains || []),
      ...(s.domains?.serviceDomains || []),
    ].map((d) => `https://${d.domain}`),
  }));
  return {
    ...variables,
    projectName: projectToken.project?.name || 'Venue project',
    workspaceId: UUID.test(projectToken.project?.workspaceId || '')
      ? projectToken.project.workspaceId
      : null,
    environmentName: projectToken.environment?.name || 'Production',
    services: services.filter((s) => !s.image),
    suggested: proposeServices(services, venue),
  };
}
async function configureRailway(token, discovery, selected, fetcher = fetch) {
  const ids = Object.entries(selected).filter(([, id]) => id);
  if (
    !selected.backend ||
    !selected.admin ||
    new Set(ids.map(([, id]) => id)).size !== ids.length
  )
    throw failure(
      'Choose the backend and owner dashboard, using a different service for each selected component.',
      400,
    );
  for (const [role, id] of ids) {
    if (!ROOTS[role] || !discovery.services.some((s) => s.id === id))
      throw failure(
        'A selected service does not belong to this project environment.',
        400,
      );
  }
  const setupQuery = (query, variables) =>
    railwayQuery(token, query, variables, fetcher, 'setup');
  const access = await setupQuery(
    'query SetupAccess($projectId:String!){project(id:$projectId){id}}',
    { projectId: discovery.projectId },
  );
  if (access.project?.id !== discovery.projectId)
    throw Object.assign(
      failure(
        'The setup token cannot manage this venue’s Railway project.',
        403,
      ),
      { operation: 'SetupAccess', code: 'RAILWAY_ACCESS_DENIED' },
    );
  for (const [role, serviceId] of ids) {
    const service = discovery.services.find((s) => s.id === serviceId);
    const variables = {
      serviceId,
      projectId: discovery.projectId,
      environmentId: discovery.environmentId,
    };
    // Only the environment discovered from the venue's project token and the
    // selected application services are changed, even with workspace access.
    await setupQuery(
      `mutation TakeControl($input:ServiceInstanceAutoDeployUpdateInput!){serviceInstanceAutoDeployUpdate(input:$input){enabled}}`,
      { input: { ...variables, enabled: false } },
    );
    if (root(service.rootDirectory) !== ROOTS[role])
      await setupQuery(
        `mutation SetRoot($serviceId:String!,$environmentId:String,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}`,
        {
          serviceId,
          environmentId: discovery.environmentId,
          input: { rootDirectory: ROOTS[role] },
        },
      );
    const { serviceInstanceAutoDeployStatus, serviceInstance } =
      await setupQuery(
        `query Verify($projectId:String!,$environmentId:String!,$serviceId:String!){
      serviceInstanceAutoDeployStatus(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId){enabled}
      serviceInstance(environmentId:$environmentId,serviceId:$serviceId){rootDirectory}
    }`,
        variables,
      );
    if (
      serviceInstanceAutoDeployStatus?.enabled !== false ||
      root(serviceInstance?.rootDirectory) !== ROOTS[role]
    )
      throw failure(
        `Railway has not confirmed update control for ${service.name}. Reconnect after checking its settings.`,
      );
  }
  return true;
}
module.exports = {
  ROOTS,
  railwayQuery,
  proposeServices,
  discoverRailway,
  configureRailway,
};
