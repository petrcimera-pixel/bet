"""Aliasy názvů týmů mezi Tipsport.cz a ESPN.

Tipsport u národních týmů používá české názvy ("Německo", "Pobřeží slonoviny"),
ESPN anglické ("Germany", "Ivory Coast"). U klubů se navíc často liší
exonymum města ("Bayern München" vs "Bayern Munich", "Sparta Praha" vs
"Sparta Prague"). Prostá diakritická normalizace (_norm_team) ani
podřetězcová shoda tohle nevyřeší - "munich" není podřetězec "munchen".

Mapování je JEDNOSMĚRNÉ: český/alternativní název (normalizovaný, bez
diakritiky, malými písmeny) -> kanonický anglický název (stejně
normalizovaný, jak ho typicky vrací ESPN). Aplikuje se před porovnáním
v tipsport_import.lookup().
"""
from __future__ import annotations

# Národní týmy - české (Tipsport) -> anglické (ESPN) názvy zemí.
# Zahrnuje jen fotbalově relevantní země, ne kompletní seznam států světa.
_NATIONAL_TEAMS = {
    "nemecko": "germany", "anglie": "england", "francie": "france",
    "spanelsko": "spain", "italie": "italy", "portugalsko": "portugal",
    "nizozemsko": "netherlands", "holandsko": "netherlands", "belgie": "belgium",
    "chorvatsko": "croatia", "polsko": "poland", "rakousko": "austria",
    "svycarsko": "switzerland", "dansko": "denmark", "svedsko": "sweden",
    "norsko": "norway", "finsko": "finland", "irsko": "republic of ireland",
    "skotsko": "scotland", "wales": "wales", "severni irsko": "northern ireland",
    "recko": "greece", "turecko": "turkey", "srbsko": "serbia",
    "cerna hora": "montenegro", "bosna a hercegovina": "bosnia and herzegovina",
    "slovinsko": "slovenia", "slovensko": "slovakia", "mad'arsko": "hungary",
    "madarsko": "hungary", "rumunsko": "romania", "bulharsko": "bulgaria",
    "ukrajina": "ukraine", "rusko": "russia", "bilorusko": "belarus",
    "island": "iceland", "lucembursko": "luxembourg", "albanie": "albania",
    "kosovo": "kosovo", "severni makedonie": "north macedonia",
    "kypr": "cyprus", "malta": "malta", "gruzie": "georgia",
    "arménie": "armenia", "armenie": "armenia", "azerbajdzan": "azerbaijan",
    "izrael": "israel", "kazachstan": "kazakhstan",
    "brazilie": "brazil", "argentina": "argentina", "uruguay": "uruguay",
    "chile": "chile", "kolumbie": "colombia", "peru": "peru",
    "ekvador": "ecuador", "paraguay": "paraguay", "bolivie": "bolivia",
    "venezuela": "venezuela", "mexiko": "mexico", "usa": "usa",
    "spojene staty": "usa", "kanada": "canada", "kostarika": "costa rica",
    "jamajka": "jamaica", "honduras": "honduras", "panama": "panama",
    "japonsko": "japan", "jizni korea": "south korea", "korejska republika": "south korea",
    "cina": "china pr", "australie": "australia", "irak": "iraq",
    "iran": "iran", "saudska arabie": "saudi arabia", "katar": "qatar",
    "spojene arabske emiraty": "united arab emirates", "jordansko": "jordan",
    "egypt": "egypt", "maroko": "morocco", "alzirsko": "algeria",
    "tunisko": "tunisia", "nigerie": "nigeria", "ghana": "ghana",
    "kamerun": "cameroon", "senegal": "senegal", "pobrezi slonoviny": "ivory coast",
    "jihoafricka republika": "south africa", "mali": "mali", "tanzanie": "tanzania",
    "thajsko": "thailand", "vietnam": "vietnam", "indonesie": "indonesia",
    "malajsie": "malaysia", "filipiny": "philippines", "indie": "india",
    "novy zeland": "new zealand",
}

# Kluby s výrazně odlišným exonymem/zkráceným názvem mezi zdroji.
# Klíč = jak to (typicky) píše Tipsport, hodnota = jak to píše ESPN.
_CLUBS = {
    "bayern mnichov": "bayern munich",
    "bayern munchen": "bayern munich",
    "sparta praha": "sparta prague",
    "slavia praha": "slavia prague",
    "viktoria plzen": "viktoria plzen",
    "dynamo drazd'any": "dynamo dresden",
    "dynamo drazdany": "dynamo dresden",
    "borussia monchengladbach": "borussia monchengladbach",
    "kolin nad rynem": "koln",
    "1. fc koln": "koln",
    "hertha berlin": "hertha berlin",
    "cervena hvezda belehrad": "red star belgrade",
    "partyzan belehrad": "partizan belgrade",
    "dynamo kyjev": "dynamo kyiv",
    "spartak moskva": "spartak moscow",
    "cska moskva": "cska moscow",
    "zenit petrohrad": "zenit st petersburg",
    "benfica lisabon": "benfica",
    "sporting lisabon": "sporting cp",
    "athletic bilbao": "athletic club",
    "inter milan": "inter milan",
    "ac milan": "ac milan",
    "boca juniors": "boca juniors",
    "river plate": "river plate",
}

ALIASES = {**_NATIONAL_TEAMS, **_CLUBS}


def resolve(normalized_name: str) -> str:
    """Vrátí kanonický (ESPN-styl) normalizovaný název, pokud existuje
    alias; jinak vrátí vstup beze změny."""
    return ALIASES.get(normalized_name, normalized_name)
