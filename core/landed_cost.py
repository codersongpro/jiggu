"""
해외의류 소싱 크롤러 - 랜딩코스트(최종원가) 계산 엔진

역할: 크롤러가 수집한 '현지 표시가'를 '국내 도착 실원가(원)'와 '예상 마진'으로 변환한다.

통관 모드 2가지 (사업 형태에 따라 계산이 완전히 달라짐)
  - proxy    : 구매대행. 고객 명의 개인통관 → 면세한도(US $200 / 그 외 $150) 적용
  - business : 사업자 사입. 면세한도 없음. 관세+부가세 전액 부과(부가세는 매입공제 옵션)

사용:
    from landed_cost import CostCalculator, Item
    calc = CostCalculator("config/cost.yaml")
    r = calc.landed_cost(Item(price=180, currency="USD", region="US",
                              category="apparel", weight_kg=0.8))
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml

Region = Literal["US", "EU", "JP"]
ClearanceMode = Literal["proxy", "business"]


@dataclass
class Item:
    """크롤러가 수집한 상품 1건."""
    price: float                       # 사이트 표시가 (현지통화)
    currency: str                      # "USD" | "EUR" | "JPY"
    region: Region                     # 발송 국가
    category: str = "apparel"          # 관세율 키
    weight_kg: float = 0.8             # 실무게 또는 부피무게 (미입력 시 의류 평균 가정)
    local_shipping: float = 0.0        # 현지 배대지까지 배송비 (현지통화)
    discount: float = 0.0              # 쿠폰/할인 (현지통화)
    name: str = ""
    url: str = ""


@dataclass
class CostResult:
    """계산 결과. 엑셀/대시보드에 그대로 컬럼으로 펼쳐 쓸 수 있는 구조."""
    item_krw: int = 0                  # 상품 실결제액(원) - VAT 차감/판매세 가산 반영
    intl_shipping_krw: int = 0         # 국제배송비(원)
    duty_krw: int = 0                  # 관세
    import_vat_krw: int = 0            # 수입 부가세
    clearance_fee_krw: int = 0         # 통관 수수료
    total_krw: int = 0                 # 최종 원가(원)
    dutiable_usd: float = 0.0          # 과세가격(USD) - 면세한도 판정 기준
    tax_free: bool = False             # 면세 적용 여부
    notes: list[str] = field(default_factory=list)


@dataclass
class MarginResult:
    sale_price_krw: int = 0
    channel_fee_krw: int = 0
    other_cost_krw: int = 0            # 국내배송+포장+반품리스크
    cost_krw: int = 0
    profit_krw: int = 0
    margin_rate: float = 0.0           # 판매가 대비 순이익률
    breakeven_krw: int = 0             # 손익분기 판매가


class CostCalculator:
    def __init__(self, config_path: str | Path = "config/cost.yaml"):
        with open(config_path, "r", encoding="utf-8") as f:
            self.cfg = yaml.safe_load(f)

    # ---------- 환율 ----------
    def fx_rate(self, currency: str) -> float:
        """실질환율 = 매매기준율 * (1 + 카드수수료). API 연동 시 base_rate만 주입 교체."""
        base = self.cfg["fx"]["base_rate"][currency]
        return base * (1 + self.cfg["fx"]["card_fee_rate"])

    # ---------- 1) 현지 실결제액 ----------
    def _net_local_price(self, item: Item) -> tuple[float, list[str]]:
        """표시가 → 실제 카드 결제되는 현지통화 금액.

        EU/JP 표시가는 부가세 포함이므로 한국 배송 시 차감된다. 이걸 빼면 원가가 20% 틀어진다.
        US는 배대지 州의 sales tax가 가산된다.
        """
        notes: list[str] = []
        tax_cfg = self.cfg["local_tax"][item.region]
        price = item.price - item.discount

        if item.region == "US":
            rate = tax_cfg["sales_tax_rate"]
            if rate > 0:
                price *= (1 + rate)
                notes.append(f"미국 판매세 {rate:.1%} 가산")
            else:
                notes.append("면세 州 배대지 기준(판매세 0)")
        else:
            rate = tax_cfg["vat_rate"]
            if tax_cfg["price_includes_tax"]:
                price /= (1 + rate)
                notes.append(f"{item.region} 부가세 {rate:.0%} 차감(수출 면세)")
            else:
                notes.append(f"{item.region} 표시가가 세금 별도 기준")

        return price + item.local_shipping, notes

    # ---------- 2) 국제배송비 ----------
    def intl_shipping_krw(self, weight_kg: float, region: Region) -> int:
        rates = self.cfg["shipping"]["rates_krw"][region]
        handling = self.cfg["shipping"]["handling_fee_krw"]
        for limit in sorted(rates.keys()):
            if weight_kg <= limit:
                return int(rates[limit] + handling)
        max_limit = max(rates.keys())
        extra = (weight_kg - max_limit) * self.cfg["shipping"]["over_max_per_kg_krw"][region]
        return int(rates[max_limit] + extra + handling)

    # ---------- 3) 관부가세 ----------
    def _customs(self, dutiable_krw: float, item: Item, mode: ClearanceMode
                 ) -> tuple[int, int, float, bool, list[str]]:
        c = self.cfg["customs"]
        notes: list[str] = []
        usd_rate = self.cfg["fx"]["base_rate"]["USD"]
        dutiable_usd = dutiable_krw / usd_rate

        if mode == "proxy":
            limit = c["personal_exemption_usd"][item.region]
            if dutiable_usd <= limit:
                notes.append(f"면세 적용(과세가격 ${dutiable_usd:.0f} ≤ ${limit})")
                return 0, 0, dutiable_usd, True, notes
            notes.append(f"면세한도 초과(${dutiable_usd:.0f} > ${limit}) → 전체 금액 과세")

        duty_rate = c["duty_rates"].get(item.category, c["duty_rates"]["default"])
        duty = dutiable_krw * duty_rate
        vat = (dutiable_krw + duty) * c["vat_rate"]
        notes.append(f"관세 {duty_rate:.0%} + 부가세 {c['vat_rate']:.0%}")
        return int(duty), int(vat), dutiable_usd, False, notes

    # ---------- 통합 ----------
    def landed_cost(self, item: Item, mode: ClearanceMode = "proxy",
                    vat_deductible: bool = False) -> CostResult:
        """최종 원가 계산.

        vat_deductible: 사업자로서 수입 부가세를 매입세액공제 받는 경우 True
                        → 실질 원가에서 부가세를 제외한다.
        """
        local_price, notes = self._net_local_price(item)
        item_krw = local_price * self.fx_rate(item.currency)
        ship_krw = self.intl_shipping_krw(item.weight_kg, item.region)

        dutiable = item_krw + (ship_krw if self.cfg["customs"]["include_shipping_in_dutiable"] else 0)
        duty, vat, dutiable_usd, tax_free, cnotes = self._customs(dutiable, item, mode)

        clearance = self.cfg["customs"]["clearance_fee_krw"] if mode == "business" else 0
        counted_vat = 0 if (vat_deductible and mode == "business") else vat
        if vat_deductible and mode == "business":
            cnotes.append("부가세 매입세액공제 가정 → 원가에서 제외")

        total = item_krw + ship_krw + duty + counted_vat + clearance

        return CostResult(
            item_krw=int(item_krw),
            intl_shipping_krw=ship_krw,
            duty_krw=duty,
            import_vat_krw=counted_vat,
            clearance_fee_krw=clearance,
            total_krw=int(total),
            dutiable_usd=round(dutiable_usd, 1),
            tax_free=tax_free,
            notes=notes + cnotes,
        )

    # ---------- 마진 ----------
    def margin(self, cost: CostResult, sale_price_krw: float,
               channel: str = "smartstore") -> MarginResult:
        s = self.cfg["sales"]
        fee_rate = s["channel_fee_rate"][channel]
        fee = sale_price_krw * fee_rate
        other = s["domestic_shipping_krw"] + s["packaging_krw"] + cost.total_krw * s["return_rate"]
        profit = sale_price_krw - fee - other - cost.total_krw
        breakeven = (cost.total_krw + other) / (1 - fee_rate)
        return MarginResult(
            sale_price_krw=int(sale_price_krw),
            channel_fee_krw=int(fee),
            other_cost_krw=int(other),
            cost_krw=cost.total_krw,
            profit_krw=int(profit),
            margin_rate=round(profit / sale_price_krw, 4) if sale_price_krw else 0.0,
            breakeven_krw=int(breakeven),
        )


# ---------- 검증용 실행 ----------
if __name__ == "__main__":
    calc = CostCalculator(Path(__file__).resolve().parent.parent / "config" / "cost.yaml")

    cases = [
        ("미국 $180 셔츠 / 구매대행", Item(180, "USD", "US", "apparel", 0.8), "proxy"),
        ("미국 $260 자켓 / 구매대행(한도초과)", Item(260, "USD", "US", "apparel", 1.5), "proxy"),
        ("미국 $260 자켓 / 사업자 사입", Item(260, "USD", "US", "apparel", 1.5), "business"),
        ("이탈리아 €200 니트(VAT포함) / 구매대행", Item(200, "EUR", "EU", "apparel", 1.0), "proxy"),
        ("일본 ¥19800 셋업(세込) / 구매대행", Item(19800, "JPY", "JP", "apparel", 1.2), "proxy"),
    ]

    for label, item, mode in cases:
        r = calc.landed_cost(item, mode=mode)
        print(f"\n=== {label} ===")
        print(f"  상품 실결제 {r.item_krw:,}원 + 배송 {r.intl_shipping_krw:,}원 "
              f"+ 관세 {r.duty_krw:,}원 + 부가세 {r.import_vat_krw:,}원")
        print(f"  과세가격 ${r.dutiable_usd} / 면세={r.tax_free}")
        print(f"  >> 최종원가 {r.total_krw:,}원")
        print(f"  note: {' | '.join(r.notes)}")
        m = calc.margin(r, sale_price_krw=r.total_krw * 1.6)
        print(f"  판매가 {m.sale_price_krw:,}원 → 순이익 {m.profit_krw:,}원 "
              f"({m.margin_rate:.1%}) / 손익분기 {m.breakeven_krw:,}원")
