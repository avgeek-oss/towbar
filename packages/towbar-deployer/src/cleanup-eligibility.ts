// Shared by the read-only preview and the removal-time safety check.
export const cleanupEligibilityPython = String.raw`
def cleanup_skip_reason(kind, name, value, deployable, plan, protected_images, references):
    if not deployable:
        return "Ownership could not be verified"
    if deployable in plan.get("protectedDeployableIds", []):
        return "Workload has pending work, a manifest conflict, or a domain handoff"
    active = deployable in plan["deployableIds"]
    labels = (value.get("Labels") or {}) if kind == "volume" else ((value.get("Config") or {}).get("Labels") or {})
    if kind == "container":
        if (name in plan["containerNames"]
            or labels.get("com.docker.compose.project") in plan.get("composeProjects", [])
            or (active and value.get("State", {}).get("Running"))):
            return "Container is active or retained for rollback"
    elif kind == "volume":
        host_logs = labels.get("towbar.storage") == "host-logs" and name == "towbar-host-logs-" + labels.get("towbar.runtime", "")
        if references():
            return "Volume still has container references"
        if active and not host_logs:
            return "Volume belongs to an active workload"
    elif kind == "image":
        if name in plan["imageTags"] or value["Id"] in protected_images:
            return "Image is retained for deployment or rollback"
        if references():
            return "Image still has container references"
    return None
`;
