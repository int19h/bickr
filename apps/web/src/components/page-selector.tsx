import { loopPagePagerItems } from "../loop-page-pager";

export function PageSelector({ currentPage, pageCount, disabled, label, onSelect }: {
	currentPage: number;
	pageCount: number;
	disabled: boolean;
	label: string;
	onSelect: (page: number) => void;
}) {
	const items = loopPagePagerItems({ currentPage, pageCount, pages: [] });
	if (items.length === 0) return null;
	return <nav aria-label={label} className="loop-page-pager forum-page-pager">
		<span className="loop-page-pager-label">Page:</span>
		{items.map((item) => <button key={item.kind === "page" ? item.page : item.direction}
			type="button" className={`loop-page-link ${item.kind === "page" && item.current ? "active" : ""} ${item.kind === "ellipsis" ? "ellipsis" : ""}`}
			disabled={disabled} aria-current={item.kind === "page" && item.current ? "page" : undefined}
			aria-label={item.kind === "ellipsis" ? `Jump ${item.direction} to page ${item.page}` : `Open page ${item.page}`}
			onClick={() => onSelect(item.page)}>{item.kind === "ellipsis" ? "…" : item.page}</button>)}
	</nav>;
}
