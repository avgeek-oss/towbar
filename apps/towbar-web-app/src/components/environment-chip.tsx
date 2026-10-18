import { TooltipText } from "@avgeek-oss/design-system/overlays/tooltip";
import { Chip } from "@avgeek-oss/design-system/data-display/chip";
import { EnvironmentIcon } from "./environment-icon";

export function EnvironmentChip({
  name,
  showIcon = true,
  showTooltip = true,
  tooltip,
}: {
  name: string;
  showIcon?: boolean;
  showTooltip?: boolean;
  tooltip?: string;
}) {
  return (
    <TooltipText
      className="inline-flex"
      tooltip={showTooltip ? tooltip : undefined}
    >
      <Chip color={name === "production" ? "danger" : "default"}>
        <Chip.Label className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
          {showIcon ? (
            <EnvironmentIcon className="text-current" name={name} />
          ) : undefined}
          {name}
        </Chip.Label>
      </Chip>
    </TooltipText>
  );
}
