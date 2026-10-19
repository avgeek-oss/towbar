export const imageOwnershipPython = String.raw`
def has_image_tags(image):
    return any("@" not in tag for tag in image.get("RepoTags") or [])

def recorded_image_owner(name, image):
    identities = [name, image.get("Id"), *[
        digest.rsplit("@", 1)[-1] for digest in image.get("RepoDigests") or []
    ]]
    owners = {expected.get("imageOwners", {}).get(identity) for identity in identities}
    owners.discard(None)
    if len(owners) != 1: return None
    deployable = owners.pop()
    labels = (image.get("Config") or {}).get("Labels") or {}
    return deployable if labels.get("towbar.deployable", deployable) == deployable else None
`;
