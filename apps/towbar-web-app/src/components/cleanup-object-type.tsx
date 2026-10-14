import {
  BoxIcon,
  DatabaseIcon,
  NewspaperIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const icons: Record<string, typeof BoxIcon | undefined> = {
  container: BoxIcon,
  image: NewspaperIcon,
  volume: DatabaseIcon,
};

export function CleanupObjectType({ kind }: { kind: string }) {
  const icon = icons[kind];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap capitalize">
      {icon ? (
        <HugeiconsIcon
          aria-hidden="true"
          icon={icon}
          className="size-4 shrink-0 text-muted"
        />
      ) : null}
      {kind}
    </span>
  );
}
