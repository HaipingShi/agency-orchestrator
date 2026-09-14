import { Heart, Plus } from "lucide-react";
import { SponsorCard } from "./SponsorCard";
import { useLanguage } from "@/i18n/LanguageProvider";
import { sponsorsByTier, type SponsorTier } from "@/content/sponsors";
import { SITE } from "@/lib/site";
import { cn } from "@/lib/utils";

const RESERVED_BY_TIER: Record<SponsorTier, number> = {
  flagship: 1,
  standard: 3,
};

export function SponsorTierSection({ tier }: { tier: SponsorTier }) {
  const { t } = useLanguage();
  const s = t.sponsors;
  const list = sponsorsByTier(tier);
  const title = tier === "flagship" ? s.flagshipLabel : s.standardLabel;
  const desc = tier === "flagship" ? s.flagshipDesc : s.standardDesc;

  // 「虚位以待」只在该档一家都没有时占位（旗舰 1 格 / 更多档 3 格）；有赞助商就不展示空位
  // （2026-09-14 用户要求：更多赞助商不补空卡）。
  const isFlagship = tier === "flagship";
  const reservedCount = list.length > 0 ? 0 : RESERVED_BY_TIER[tier];

  return (
    <section className="container-page py-10">
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">{title}</h2>
          <span className="h-px flex-1 bg-border/70" />
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">{desc}</p>
      </div>

      {/* 一行 4 张紧凑卡（logo + 名称 + 一句话 + 权益），完整介绍悬停时浮层展示 */}
      {/* grid-cols-1 = minmax(0,1fr)：不写的话单列按内容撑宽，卡里 truncate 的长文案会把卡顶出屏幕 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {list.map((sp) => (
          <SponsorCard key={sp.id} sponsor={sp} />
        ))}

        {Array.from({ length: reservedCount }).map((_, i) => (
          <a
            key={`reserved-${i}`}
            href={SITE.sponsorContact}
            className={cn(
              "group flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.04]",
              isFlagship
                ? "min-h-[260px] gap-4 border-gold/40 hover:border-gold/70 sm:col-span-2 lg:col-span-4"
                : "min-h-[112px] gap-1.5 p-4",
            )}
          >
            <span
              className={cn(
                "grid place-items-center rounded-2xl bg-muted text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground",
                isFlagship ? "h-16 w-16" : "h-12 w-12",
              )}
            >
              <Plus className={isFlagship ? "size-7" : "size-5"} />
            </span>
            <span className={cn("font-semibold", isFlagship ? "text-2xl" : "text-base")}>{s.reserved}</span>
            <span className={cn("text-muted-foreground", isFlagship ? "max-w-md text-sm" : "max-w-[200px] text-xs")}>
              {s.reservedDesc}
            </span>
            <span
              className={cn(
                "mt-1 inline-flex items-center gap-1.5 font-medium text-primary",
                isFlagship ? "text-sm" : "text-xs",
              )}
            >
              <Heart className={isFlagship ? "size-4" : "size-3"} />
              {s.becomeCta}
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
