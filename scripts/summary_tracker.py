"""Lightweight summary tracker for reporting added or modified records during script execution."""

from pathlib import Path
from typing import Dict, List, Set

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SUMMARIES_DIR = PROJECT_ROOT / "data" / "summaries"


class SummaryTracker:
    def __init__(self, filename: str):
        self.filename = filename
        self.output_path = SUMMARIES_DIR / filename
        # Maps category (e.g. "EVENTS", "PLAYERS", "RANKINGS") to record dicts:
        # "new": list/set of names
        # "modified": list/set of names
        self.categories: Dict[str, Dict[str, List[str]]] = {}

    def _ensure_category(self, category: str):
        if category not in self.categories:
            self.categories[category] = {"new": [], "modified": []}

    def record_new(self, category: str, name: str):
        self._ensure_category(category)
        if name not in self.categories[category]["new"]:
            self.categories[category]["new"].append(name)

    def record_modified(self, category: str, name: str):
        self._ensure_category(category)
        # Avoid duplicates and avoid adding to modified if it's already recorded as new
        if name not in self.categories[category]["new"] and name not in self.categories[category]["modified"]:
            self.categories[category]["modified"].append(name)

    def generate_summary_text(self) -> str:
        lines = [
            "SUMMARY:",
            "-------------",
        ]
        for category, records in self.categories.items():
            lines.append("")
            lines.append(f"NEW {category.upper()}:")
            if records["new"]:
                for name in records["new"]:
                    lines.append(f"- {name}")
            else:
                lines.append("None")

            lines.append("")
            lines.append(f"MODIFIED {category.upper()}:")
            if records["modified"]:
                for name in records["modified"]:
                    lines.append(f"- {name}")
            else:
                lines.append("None")

        lines.append("")
        return "\n".join(lines)

    def write_summary(self):
        SUMMARIES_DIR.mkdir(parents=True, exist_ok=True)
        content = self.generate_summary_text()
        with self.output_path.open("w", encoding="utf-8") as f:
            f.write(content)
        print(f"Wrote summary report to {self.output_path.relative_to(PROJECT_ROOT)}")
