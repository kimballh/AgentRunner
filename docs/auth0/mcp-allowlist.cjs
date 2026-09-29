// Replace this with mcp.public_url before deploying the Auth0 Post Login Action.
const MCP_RESOURCE = "https://YOUR-STABLE-NGROK-DOMAIN/mcp";

exports.onExecutePostLogin = async (event, api) => {
  if (event.resource_server?.identifier !== MCP_RESOURCE) return;

  // Configure this Action secret as a JSON array matching mcp.oauth.allowed_subjects.
  let subjects;
  try {
    subjects = JSON.parse(event.secrets?.MCP_ALLOWED_SUBJECTS ?? "");
  } catch {
    return api.access.deny("AgentRunner access policy is not configured.");
  }
  if (!Array.isArray(subjects) || !subjects.every((subject) => typeof subject === "string" && subject.length > 0)) {
    return api.access.deny("AgentRunner access policy is not configured.");
  }
  if (!subjects.includes(event.user?.user_id)) {
    return api.access.deny("This account is not authorized to connect to AgentRunner.");
  }
};
