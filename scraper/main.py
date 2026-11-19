import os
import re
import sys
import json
import time
import smtplib
import traceback
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import requests
import chompjs
import pandas as pd
from bs4 import BeautifulSoup
from tenacity import retry, stop_after_attempt, wait_exponential
import google.auth
import gspread
from apify_client import ApifyClient
from google.cloud import bigquery
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

# =====================================================================
# 1. ENVIRONMENT & CONFIGURATION
# =====================================================================
PROJECT_ID = os.getenv("GCP_PROJECT_ID", "your-gcp-project-id")
BQ_DATASET = os.getenv("BQ_DATASET", "music_campaigns")
APIFY_SECRET = os.getenv("APIFY_SECRET", "my-apify-secret")
SHEET_ID = os.getenv("SHEET_ID", "1yyri3E5ex6pk414kkal0yH--FqJSeQ8rQPynVOJYP8k")
CAMPAIGN_CONFIG_TAB = os.getenv("CAMPAIGN_CONFIG_TAB", "Campaign_Schedule")
CAMPAIGN_LINKS_TAB = os.getenv("CAMPAIGN_LINKS_TAB", "campaign_file")
RESULTS_TAB = os.getenv("RESULTS_TAB", "Hoja 1")
GOVERNANCE_TAB = os.getenv("GOVERNANCE_TAB", "Governance")
LOGS_TAB = os.getenv("LOGS_TAB", "Access")
LOCAL_TZ = ZoneInfo(os.getenv("TZ", "America/Mexico_City"))

# Alerting Config
ALERT_WEBHOOK_URL = os.getenv("ALERT_WEBHOOK_URL", "")
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_FROM = os.getenv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")
WHATSAPP_TO = os.getenv("WHATSAPP_TO", "")
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
ALERT_EMAIL_TO = os.getenv("ALERT_EMAIL_TO", "gustavo.hiram.gutierrez@gmail.com")


# =====================================================================
# 2. MULTI-CHANNEL ALERTING (SLACK / WHATSAPP / EMAIL)
# =====================================================================
def send_alerts(subject: str, message: str):
    """Dispatches failure or warning alerts via Slack, WhatsApp, and Email."""
    print(f"[ALERT] {subject}\n{message}")
    # A. Slack / Discord / Custom Webhook
    if ALERT_WEBHOOK_URL:
        try:
            requests.post(
                ALERT_WEBHOOK_URL,
                json={"text": f"*{subject}*\n{message}"},
                timeout=10,
            )
        except Exception as e:
            print(f"Webhook alert error: {e}")

    # B. WhatsApp via Twilio API (if configured)
    if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and WHATSAPP_TO:
        try:
            twilio_url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json"
            requests.post(
                twilio_url,
                auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN),
                data={
                    "From": TWILIO_WHATSAPP_FROM,
                    "To": WHATSAPP_TO,
                    "Body": f"{subject}\n\n{message[:1400]}",
                },
                timeout=10,
            )
        except Exception as e:
            print(f"WhatsApp alert error: {e}")

    # C. Email via Gmail SMTP
    if SMTP_USER and SMTP_PASSWORD:
        try:
            recipients = [e.strip() for e in ALERT_EMAIL_TO.split(",") if e.strip()]
            msg = MIMEMultipart()
            msg["From"] = SMTP_USER
            msg["To"] = ", ".join(recipients)
            msg["Subject"] = subject
            msg.attach(MIMEText(message, "plain"))
            with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.sendmail(SMTP_USER, recipients, msg.as_string())
        except Exception as e:
            print(f"Email alert error: {e}")


# =====================================================================
# 3. CAMPAIGN DURATION & ACTIVE WINDOW EVALUATOR
# =====================================================================
def parse_sheet_date(val) -> date | None:
    """Safely parses YYYY-MM-DD or DD/MM/YYYY dates from Google Sheets."""
    if val is None or str(val).strip() == "":
        return None
    try:
        return pd.to_datetime(str(val).strip()).date()
    except Exception:
        return None


def is_row_active_today(row: dict, today: date) -> bool:
    """
    Determines whether a campaign or link row is active on `today`.
    Supports:
    1. Optional manual kill-switch column: `active` (FALSE / 0 / NO -> inactive)
    2. `start_date` and `end_date` (YYYY-MM-DD)
    3. `start_date` and `duration_days` (integer days from start_date)
    """
    active_flag = str(row.get("active", "TRUE")).strip().upper()
    if active_flag in ("FALSE", "0", "NO", "INACTIVE", "PAUSED"):
        return False
    start_dt = parse_sheet_date(row.get("start_date"))
    end_dt = parse_sheet_date(row.get("end_date"))
    if start_dt and not end_dt and row.get("duration_days") not in (None, ""):
        try:
            days = int(float(row["duration_days"]))
            end_dt = start_dt + timedelta(days=max(days - 1, 0))
        except Exception:
            pass
    if start_dt and today < start_dt:
        return False
    if end_dt and today > end_dt:
        return False
    return True


def filter_active_campaign_links(sh: gspread.Spreadsheet, raw_links_df: pd.DataFrame, today: date) -> pd.DataFrame:
    """
    Filters `campaign_file` rows to ONLY those belonging to currently active campaigns.
    Supports either a master `Campaign_Schedule` tab or inline `start_date`/`end_date` columns.
    """
    df = raw_links_df.copy()
    schedule_records = []
    try:
        sched_ws = sh.worksheet(CAMPAIGN_CONFIG_TAB)
        schedule_records = sched_ws.get_all_records()
    except gspread.WorksheetNotFound:
        schedule_records = []

    if schedule_records:
        sched_df = pd.DataFrame(schedule_records)
        active_campaigns = set()
        meta_lookup = {}
        for _, s_row in sched_df.iterrows():
            camp_name = str(s_row.get("campaign", "")).strip()
            if camp_name and is_row_active_today(s_row, today):
                active_campaigns.add(camp_name.lower())
                meta_lookup[camp_name.lower()] = {
                    "artist": str(s_row.get("artist", "")).strip(),
                    "company": str(s_row.get("company", "")).strip(),
                }
        if not active_campaigns:
            return pd.DataFrame()
        if "campaign" in df.columns:
            df = df[df["campaign"].astype(str).str.strip().str.lower().isin(active_campaigns)].copy()
            for idx, r in df.iterrows():
                c_key = str(r["campaign"]).strip().lower()
                if c_key in meta_lookup:
                    if not str(r.get("artist", "")).strip():
                        df.at[idx, "artist"] = meta_lookup[c_key]["artist"]
                    if not str(r.get("company", "")).strip():
                        df.at[idx, "company"] = meta_lookup[c_key]["company"]

    if any(col in df.columns for col in ["start_date", "end_date", "duration_days", "active"]):
        mask = df.apply(lambda r: is_row_active_today(r.to_dict(), today), axis=1)
        df = df[mask].copy()
    return df


# =====================================================================
# 4. HEADLESS CHROME DRIVER & HELPERS
# =====================================================================
def create_headless_driver() -> webdriver.Chrome:
    """Initializes Headless Chromium optimized for Google Cloud Run containers."""
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-gpu")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.add_argument("--lang=en-US")
    chrome_options.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    )
    chrome_bin = os.getenv("CHROME_BIN")
    chromedriver_path = os.getenv("CHROMEDRIVER_PATH")
    if chrome_bin:
        chrome_options.binary_location = chrome_bin
    if chromedriver_path and os.path.exists(chromedriver_path):
        service = Service(executable_path=chromedriver_path)
        return webdriver.Chrome(service=service, options=chrome_options)
    return webdriver.Chrome(options=chrome_options)


def parse_metric_number(val) -> int:
    """Converts strings like '12.4K', '1.2M', '1,450', or 'Share' into clean integers."""
    if val is None or val == "":
        return 0
    s = str(val).strip()
    for word in ["views", "likes", "like", "comments", "Share", ","]:
        s = s.replace(word, "")
    s = s.replace("thousand", "K").replace("million", "M").strip()
    try:
        if "K" in s.upper():
            return int(float(s.upper().replace("K", "").strip()) * 1000)
        if "M" in s.upper():
            return int(float(s.upper().replace("M", "").strip()) * 1000000)
        return int(float(s))
    except Exception:
        return 0


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=2, min=2, max=10))
def fetch_page_html(driver: webdriver.Chrome, url: str) -> str:
    """Loads URL in Selenium with automatic retry on transient timeout."""
    driver.get(url.strip())
    time.sleep(2.5)
    return driver.page_source


# =====================================================================
# 5. PLATFORM SCRAPERS
# =====================================================================
def scrape_tiktok(driver: webdriver.Chrome, url: str) -> dict:
    html = fetch_page_html(driver, url)
    soup = BeautifulSoup(html, "html.parser")
    meta = None

    # Check the primary hydration script first, then fall back to all <script> tags
    scripts = []
    rehydration_tag = soup.find("script", id="__UNIVERSAL_DATA_FOR_REHYDRATION__")
    if rehydration_tag:
        scripts.append(rehydration_tag)
    scripts.extend(soup.find_all("script"))

    for script in scripts:
        # Use .get_text() instead of .string so tags with comments aren't skipped
        raw_text = script.get_text(strip=True)
        if not raw_text or "__DEFAULT_SCOPE__" not in raw_text:
            continue
        try:
            payload = json.loads(raw_text)
            item_struct = (
                payload.get("__DEFAULT_SCOPE__", {})
                .get("webapp.video-detail", {})
                .get("itemInfo", {})
                .get("itemStruct", {})
            )
            # Fall back to 'stats' when 'statsV2' is omitted (common on photo posts)
            meta = item_struct.get("statsV2") or item_struct.get("stats")
            if meta:
                break
        except Exception:
            continue

    if not meta:
        raise ValueError(f"TikTok stats JSON block not found on page: {url}")

    return {
        "likes": parse_metric_number(meta.get("diggCount", 0)),
        "shares": parse_metric_number(meta.get("shareCount", 0)),
        "comments": parse_metric_number(meta.get("commentCount", 0)),
        "views": parse_metric_number(meta.get("playCount", 0)),
        "bookmarks": parse_metric_number(meta.get("collectCount", 0)),
        "repost": parse_metric_number(meta.get("repostCount", 0)),
        "favorites": 0,
        "all_reactions": 0,
        "reply": 0,
    }


def scrape_tiktok_batch_apify(urls: list[str]) -> dict[str, dict]:
    """
    Runs a single Apify Actor call for all TikTok URLs that failed Selenium scraping.
    Returns a mapping of {original_url: metrics_dict} for successfully scraped items.
    """
    unique_urls = list(dict.fromkeys(u.strip() for u in urls if u and u.strip()))
    if not unique_urls:
        return {}

    client = ApifyClient(APIFY_SECRET)
    run_input = {
        "postURLs": unique_urls,
        "shouldDownloadVideos": False,
        "shouldDownloadCovers": False,
        "shouldDownloadSlideshowImages": False,
        "commentsPerPost": 0,
        "scrapeRelatedVideos": False,
    }

    run = client.actor("clockworks/tiktok-scraper").call(run_input=run_input)

    # Normalize URLs for matching (handles trailing slashes & short-link redirects)
    norm_to_originals: dict[str, list[str]] = {}
    for orig in unique_urls:
        norm = orig.rstrip("/")
        norm_to_originals.setdefault(norm, []).append(orig)

    results_by_url: dict[str, dict] = {}
    for item in client.dataset(run["defaultDatasetId"]).iterate_items():
        # Skip error items returned by Apify for private/deleted videos
        if item.get("error") or (item.get("playCount") is None and item.get("diggCount") is None):
            continue

        metrics = {
            "likes": parse_metric_number(item.get("diggCount", 0)),
            "shares": parse_metric_number(item.get("shareCount", 0)),
            "comments": parse_metric_number(item.get("commentCount", 0)),
            "views": parse_metric_number(item.get("playCount", 0)),
            "bookmarks": parse_metric_number(item.get("collectCount", 0)),
            "repost": parse_metric_number(item.get("repostCount", 0)),
            "favorites": 0,
            "all_reactions": 0,
            "reply": 0,
        }

        # Match back to the submitted URL (critical for vm.tiktok.com short links)
        candidates = [
            str(item.get("submittedVideoUrl") or "").strip().rstrip("/"),
            str(item.get("input") or "").strip().rstrip("/"),
            str(item.get("webVideoUrl") or "").strip().rstrip("/"),
        ]
        for cand in candidates:
            if cand and cand in norm_to_originals:
                for orig_url in norm_to_originals[cand]:
                    results_by_url[orig_url] = metrics
                break

    return results_by_url


def scrape_facebook_reel(driver: webdriver.Chrome, url: str) -> dict:
    html = fetch_page_html(driver, url)
    soup_fb = BeautifulSoup(html, "html.parser")
    fb_id_match = re.findall(r"reel/(\d+)", url)
    fb_id = fb_id_match[0] if fb_id_match else ""
    res = {"likes": 0, "all_reactions": 0, "comments": 0, "shares": 0, "views": 0}
    for e in soup_fb.find_all("script"):
        if not e.string or "__bbox" not in e.string:
            continue
        try:
            data_json = json.loads(e.string)
            bbox = data_json["require"][0][3][0]["__bbox"]["require"][1][3][1]["__bbox"]["result"]["data"]
            if not fb_id or str(bbox.get("video", {}).get("id", "")) == fb_id:
                fb_node = bbox.get("feedback", {})
                res["likes"] = parse_metric_number(fb_node.get("likers", {}).get("count", 0))
                res["all_reactions"] = parse_metric_number(fb_node.get("unified_reactors", {}).get("count", 0))
                res["comments"] = parse_metric_number(fb_node.get("total_comment_count", 0))
                res["shares"] = parse_metric_number(fb_node.get("share_count_reduced", 0))
                break
        except Exception:
            continue
    return res


def scrape_facebook_post(driver: webdriver.Chrome, url: str) -> dict:
    html = fetch_page_html(driver, url)
    soup_fb_post = BeautifulSoup(html, "html.parser")
    res = {"likes": 0, "all_reactions": 0, "comments": 0, "shares": 0, "views": 0}
    meta_fb_post = None
    for script in soup_fb_post.find_all("script"):
        if script.string and '"reaction_count"' in script.string:
            try:
                meta_fb_post = json.loads(script.string)
                break
            except Exception:
                continue
    if meta_fb_post:
        try:
            fb_obj = (
                meta_fb_post["require"][0][3][0]["__bbox"]["require"][85][3][1]["__bbox"]
                ["result"]["data"]["node"]["comet_sections"]["feedback"]["story"]
                ["comet_feed_ufi_container"]["story"]["feedback_context"]
                ["feedback_target_with_context"]["ufi_renderer"]["feedback"]
                ["comet_ufi_summary_and_actions_renderer"]["feedback"]
            )
            res["all_reactions"] = parse_metric_number(fb_obj.get("reaction_count", {}).get("count", 0))
            res["likes"] = parse_metric_number(fb_obj.get("top_reactions", {}).get("edges", [{}, {}])[1].get("reaction_count", 0))
            res["comments"] = parse_metric_number(fb_obj.get("comment_rendering_instance", {}).get("comments", {}).get("total_count", 0))
            res["shares"] = parse_metric_number(fb_obj.get("share_count", {}).get("count", 0))
        except Exception:
            pass
    return res


def scrape_facebook_live(driver: webdriver.Chrome, url: str) -> dict:
    html = fetch_page_html(driver, url)
    soup_fb_live = BeautifulSoup(html, "html.parser")
    res = {"likes": 0, "all_reactions": 0, "comments": 0, "shares": 0, "views": 0}
    meta_fb_post = None
    for script in soup_fb_live.find_all("script"):
        if script.string and '"reaction_count"' in script.string:
            try:
                meta_fb_post = json.loads(script.string)
                break
            except Exception:
                continue
    if meta_fb_post:
        try:
            fb_data = meta_fb_post["require"][0][3][0]["__bbox"]["require"][29][3][1]["__bbox"]["result"]["data"]
            res["comments"] = parse_metric_number(fb_data.get("comment_rendering_instance", {}).get("comments", {}).get("total_count", 0))
            res["all_reactions"] = parse_metric_number(fb_data.get("i18n_reaction_count", 0))
            res["views"] = parse_metric_number(fb_data.get("video_view_count_renderer", {}).get("feedback", {}).get("video_view_count", 0))
            for edge in fb_data.get("top_reactions", {}).get("edges", []):
                if edge.get("node", {}).get("localized_name") == "Like":
                    res["likes"] = parse_metric_number(edge.get("reaction_count", 0))
                    break
        except Exception:
            pass
    return res


def scrape_instagram(driver: webdriver.Chrome, url: str) -> dict:
    html = fetch_page_html(driver, url)
    soup_ig = BeautifulSoup(html, "html.parser")
    likes, comments = 0, 0
    for m in soup_ig.find_all("meta"):
        content = m.get("content", "")
        if "likes" in content and "comments" in content:
            try:
                like_str = re.findall(r"([\d.,KMkm]+)\s+likes", content)[0]
                comm_str = re.findall(r"([\d.,KMkm]+)\s+comments", content)[0]
                likes = parse_metric_number(like_str)
                comments = parse_metric_number(comm_str)
                break
            except Exception:
                continue
    return {"likes": likes, "comments": comments, "views": 0, "shares": 0}


def scrape_youtube(driver: webdriver.Chrome, url: str) -> dict:
    html = fetch_page_html(driver, url)
    soup_yt = BeautifulSoup(html, "html.parser")
    res = {"views": 0, "likes": 0, "comments": 0}
    script_tag = soup_yt.find("script", string=re.compile(r"var\s+ytInitialData\s*="))
    if not script_tag:
        return res
    match = re.search(r"var\s+ytInitialData\s*=\s*(.*?);\s*$", script_tag.string, re.DOTALL)
    if not match:
        return res
    yt_metadata = chompjs.parse_js_object(match.group(1))
    contents = yt_metadata["contents"]["twoColumnWatchNextResults"]["results"]["results"]["contents"]
    for idx in [1, 0]:
        try:
            primary = contents[idx]["videoPrimaryInfoRenderer"]
            pre_views = primary["viewCount"]["videoViewCountRenderer"]["viewCount"]["simpleText"]
            res["views"] = parse_metric_number(pre_views)
            like_text = (
                primary["videoActions"]["menuRenderer"]["topLevelButtons"][0]
                ["segmentedLikeDislikeButtonViewModel"]["likeButtonViewModel"]
                ["likeButtonViewModel"]["toggleButtonViewModel"]["toggleButtonViewModel"]
                ["defaultButtonViewModel"]["buttonViewModel"]["accessibilityText"]
            )
            like_match = re.findall(r"(\S+)\s+other people", like_text)
            if like_match:
                res["likes"] = parse_metric_number(like_match[0])
            break
        except Exception:
            continue
    for idx in [3, 2]:
        try:
            comm_text = contents[idx]["itemSectionRenderer"]["contents"][0]["commentsEntryPointHeaderRenderer"]["headerText"]["runs"][0]["text"]
            res["comments"] = parse_metric_number(comm_text)
            break
        except Exception:
            continue
    return res


def scrape_youtube_shorts(driver: webdriver.Chrome, url: str) -> dict:
    html = fetch_page_html(driver, url)
    soup_yts = BeautifulSoup(html, "html.parser")
    res = {"views": 0, "likes": 0, "comments": 0}
    script_tag = soup_yts.find("script", string=re.compile(r"var\s+ytInitialData\s*="))
    if not script_tag:
        return res
    match = re.search(r"var\s+ytInitialData\s*=\s*(.*?);\s*$", script_tag.string, re.DOTALL)
    if not match:
        return res
    player_data = chompjs.parse_js_object(match.group(1))
    for panel in player_data.get("engagementPanels", []):
        try:
            header = (
                panel["engagementPanelSectionListRenderer"]["content"]
                ["structuredDescriptionContentRenderer"]["items"][0]["videoDescriptionHeaderRenderer"]
            )
            res["views"] = parse_metric_number(header["views"]["simpleText"])
            res["likes"] = parse_metric_number(header["factoid"][0]["factoidRenderer"]["accessibilityText"])
            break
        except Exception:
            continue
    return res


# =====================================================================
# 6. BIGQUERY IDEMPOTENT MERGE LOADER & GOVERNANCE SYNC
# =====================================================================
def upsert_to_bigquery(bq_client: bigquery.Client, df: pd.DataFrame):
    """Loads today's scraped DataFrame into staging and MERGEs into fact_rrss_daily."""
    if df.empty:
        return
    df_bq = df.copy()
    df_bq["snapshot_date"] = pd.to_datetime(df_bq["created_at"]).dt.date
    df_bq["url"] = df_bq["url"].astype(str).str.strip()
    cols = [
        "snapshot_date", "platform", "url", "likes", "all_reactions",
        "comments", "shares", "favorites", "views", "repost",
        "reply", "bookmarks", "campaign", "artist"
    ]
    df_bq = df_bq[cols].sort_values("views", ascending=False).drop_duplicates(
        subset=["snapshot_date", "campaign", "url"], keep="first"
    )
    staging_table = f"{PROJECT_ID}.{BQ_DATASET}.stg_rrss_daily"
    target_table = f"{PROJECT_ID}.{BQ_DATASET}.fact_rrss_daily"
    job_config = bigquery.LoadJobConfig(write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE)
    bq_client.load_table_from_dataframe(df_bq, staging_table, job_config=job_config).result()

    merge_sql = f"""
    MERGE `{target_table}` T
    USING `{staging_table}` S
    ON T.snapshot_date = S.snapshot_date AND T.campaign = S.campaign AND T.url = S.url
    WHEN MATCHED THEN
    UPDATE SET
        platform = S.platform, likes = S.likes, all_reactions = S.all_reactions,
        comments = S.comments, shares = S.shares, favorites = S.favorites,
        views = S.views, repost = S.repost, reply = S.reply,
        bookmarks = S.bookmarks, artist = S.artist
    WHEN NOT MATCHED THEN
    INSERT (snapshot_date, platform, url, likes, all_reactions, comments, shares, favorites, views, repost, reply, bookmarks, campaign, artist)
    VALUES (S.snapshot_date, S.platform, S.url, S.likes, S.all_reactions, S.comments, S.shares, S.favorites, S.views, S.repost, S.reply, S.bookmarks, S.campaign, S.artist)
    """
    bq_client.query(merge_sql).result()
    print(f"✅ BigQuery MERGE complete: {len(df_bq)} rows synced to {target_table}")


def sync_governance_access(sh: gspread.Spreadsheet, active_df: pd.DataFrame):
    """Ensures every active (artist, company) pair has default admin access in Governance tab."""
    if "artist" not in active_df.columns:
        return
    try:
        gov_ws = sh.worksheet(GOVERNANCE_TAB)
        existing_gov = pd.DataFrame(gov_ws.get_all_records())
        default_admins = [
            "info@tauromkt.com",
            "gustavo.hiram.gutierrez@gmail.com",
            "frida@tauromkt.com",
        ]
        new_rows = []
        for _, r in active_df[["artist", "company"]].drop_duplicates().iterrows():
            artist_name = str(r.get("artist", "")).strip()
            label_company = str(r.get("company", "")).strip()
            if not artist_name:
                continue
            for email in default_admins:
                new_rows.append({"artist": artist_name, "email": email, "company": label_company})
        if new_rows:
            new_access_df = pd.DataFrame(new_rows)
            combined = pd.concat([existing_gov, new_access_df], ignore_index=True).drop_duplicates(
                subset=["artist", "email"]
            )
            gov_ws.update([combined.columns.values.tolist()] + combined.fillna("").values.tolist())
    except Exception as e:
        print(f"Governance sync note: {e}")


# =====================================================================
# 7. MAIN ORCHESTRATION ENTRYPOINT
# =====================================================================
def main():
    now_local = datetime.now(LOCAL_TZ)
    today_date = now_local.date()
    start_ts = now_local.strftime("%Y-%m-%d %H:%M:%S %Z")
    print(f"🚀 Starting Automated Campaign Scraper at {start_ts} (Today: {today_date})")
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/bigquery",
    ]
    creds, _ = google.auth.default(scopes=scopes)

    gs_client = gspread.authorize(creds)
    bq_client = bigquery.Client(credentials=creds, project=PROJECT_ID)
    sh = gs_client.open_by_key(SHEET_ID)
    links_ws = sh.worksheet(CAMPAIGN_LINKS_TAB)
    raw_df = pd.DataFrame(links_ws.get_all_records())

    # Evaluate Campaign Duration Windows BEFORE starting Chrome
    active_df = filter_active_campaign_links(sh, raw_df, today_date)
    if active_df.empty:
        print(f"⏹️ No active campaigns scheduled for {today_date}. Ending process cleanly.")
        try:
            log_ws = sh.worksheet(LOGS_TAB)
            log_ws.append_row([
                start_ts,
                "NO_ACTIVE_CAMPAIGNS",
                0,
                0,
                f"No campaigns with start_date <= {today_date} <= end_date",
            ])
        except Exception:
            pass
        sys.exit(0)

    active_campaigns_list = (
        active_df["campaign"].unique().tolist()
        if "campaign" in active_df.columns
        else ["Default Campaign"]
    )
    print(f"🎯 Active Campaigns for {today_date}: {active_campaigns_list} ({len(active_df)} rows)")

    driver = create_headless_driver()
    scraped_rows = []
    failed_urls = []
    failed_tiktok_items = []  # Collects (url, campaign, artist) for a single Apify batch call

    platform_handlers = {
        "TikTok": ("TikTok", scrape_tiktok),
        "Facebook Reels": ("Facebook Reels", scrape_facebook_reel),
        "Facebook Posts": ("Facebook Posts", scrape_facebook_post),
        "Facebook Live": ("Facebook Live", scrape_facebook_live),
        "Instagram": ("Instagram", scrape_instagram),
        "Youtube": ("YouTube", scrape_youtube),
        "YouTube": ("YouTube", scrape_youtube),
        "Youtube Shorts": ("YouTube Shorts", scrape_youtube_shorts),
        "YouTube Shorts": ("YouTube Shorts", scrape_youtube_shorts),
    }

    try:
        if {"url", "platform"}.issubset(set(active_df.columns)):
            for _, row in active_df.iterrows():
                plat_col = str(row["platform"]).strip()
                url = str(row["url"]).strip()
                campaign_name = str(row.get("campaign", "Active Campaign")).strip()
                artist_name = str(row.get("artist", "Artist")).strip()
                if not url or plat_col not in platform_handlers:
                    continue
                canonical_plat, handler_fn = platform_handlers[plat_col]
                try:
                    metrics = handler_fn(driver, url)
                    scraped_rows.append({
                        "platform": canonical_plat,
                        "url": url,
                        "likes": metrics.get("likes", 0),
                        "all_reactions": metrics.get("all_reactions", 0),
                        "comments": metrics.get("comments", 0),
                        "shares": metrics.get("shares", 0),
                        "favorites": metrics.get("favorites", 0),
                        "views": metrics.get("views", 0),
                        "repost": metrics.get("repost", 0),
                        "reply": metrics.get("reply", 0),
                        "bookmarks": metrics.get("bookmarks", 0),
                        "campaign": campaign_name,
                        "artist": artist_name,
                        "created_at": str(today_date),
                    })
                except Exception as e:
                    if canonical_plat == "TikTok":
                        failed_tiktok_items.append((url, campaign_name, artist_name))
                    else:
                        failed_urls.append((url, str(e)))
        else:
            default_campaign = str(active_df["campaign"].dropna().iloc[0]) if "campaign" in active_df.columns else "Default Campaign"
            default_artist = str(active_df["artist"].dropna().iloc[0]) if "artist" in active_df.columns else "Artist"
            for col_name, (canonical_plat, handler_fn) in platform_handlers.items():
                if col_name not in active_df.columns:
                    continue
                urls = [str(u).strip() for u in active_df[col_name].dropna() if str(u).strip()]
                for url in urls:
                    try:
                        metrics = handler_fn(driver, url)
                        scraped_rows.append({
                            "platform": canonical_plat,
                            "url": url,
                            "likes": metrics.get("likes", 0),
                            "all_reactions": metrics.get("all_reactions", 0),
                            "comments": metrics.get("comments", 0),
                            "shares": metrics.get("shares", 0),
                            "favorites": metrics.get("favorites", 0),
                            "views": metrics.get("views", 0),
                            "repost": metrics.get("repost", 0),
                            "reply": metrics.get("reply", 0),
                            "bookmarks": metrics.get("bookmarks", 0),
                            "campaign": default_campaign,
                            "artist": default_artist,
                            "created_at": str(today_date),
                        })
                    except Exception as e:
                        if canonical_plat == "TikTok":
                            failed_tiktok_items.append((url, default_campaign, default_artist))
                        else:
                            failed_urls.append((url, str(e)))
    finally:
        driver.quit()

    # Single batch Apify fallback for any TikTok URLs that failed Selenium
    if failed_tiktok_items:
        print(f"🔄 Running single Apify fallback for {len(failed_tiktok_items)} failed TikTok URL(s)...")
        apify_results = {}
        try:
            apify_results = scrape_tiktok_batch_apify([item[0] for item in failed_tiktok_items])
        except Exception as apify_err:
            print(f"⚠️ Apify batch call failed: {apify_err}")

        for url, campaign_name, artist_name in failed_tiktok_items:
            try:
                metrics = apify_results.get(url)
                if not metrics:
                    raise ValueError(f"TikTok stats JSON block not found on page: {url}")

                scraped_rows.append({
                    "platform": "TikTok",
                    "url": url,
                    "likes": metrics.get("likes", 0),
                    "all_reactions": metrics.get("all_reactions", 0),
                    "comments": metrics.get("comments", 0),
                    "shares": metrics.get("shares", 0),
                    "favorites": metrics.get("favorites", 0),
                    "views": metrics.get("views", 0),
                    "repost": metrics.get("repost", 0),
                    "reply": metrics.get("reply", 0),
                    "bookmarks": metrics.get("bookmarks", 0),
                    "campaign": campaign_name,
                    "artist": artist_name,
                    "created_at": str(today_date),
                })
            except ValueError as ve:
                failed_urls.append((url, str(ve)))

    if not scraped_rows:
        send_alerts(
            "🚨 CRITICAL: Active Campaigns Returned 0 Scraped Rows",
            f"Run started at {start_ts} for active campaigns {active_campaigns_list}.\n"
            f"Failed URLs ({len(failed_urls)}):\n"
            + "\n".join([f"- {u}: {err}" for u, err in failed_urls[:10]]),
        )
        sys.exit(1)

    engagement_results = pd.DataFrame(scraped_rows)
    int_cols = ["likes", "all_reactions", "comments", "shares", "favorites", "views", "repost", "reply", "bookmarks"]
    for c in int_cols:
        if c in engagement_results.columns:
            engagement_results[c] = pd.to_numeric(engagement_results[c], errors="coerce").fillna(0).astype(int)

    upsert_to_bigquery(bq_client, engagement_results)

    if "company" in active_df.columns:
        sync_governance_access(sh, active_df)

    try:
        log_ws = sh.worksheet(LOGS_TAB)
        log_ws.append_row([
            start_ts,
            "SUCCESS" if not failed_urls else "PARTIAL_WARNING",
            len(engagement_results),
            len(failed_urls),
            f"Campaigns: {', '.join(active_campaigns_list)}",
        ])
    except Exception as e:
        print(f"Could not write to {LOGS_TAB} sheet: {e}")

    if failed_urls:
        sample = "\n".join([f"• {u} ({err})" for u, err in failed_urls[:5]])
        send_alerts(
            f"⚠️ Partial Scrape Warning ({len(failed_urls)} failed)",
            f"Successfully loaded {len(engagement_results)} posts to BigQuery for {active_campaigns_list}.\nFailures:\n{sample}",
        )
    print("🎉 Engagement Pipeline Completed Successfully!")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        tb = traceback.format_exc()
        send_alerts("🚨 CRITICAL CRASH: RRSS Cloud Run Job Failed", f"Error: {exc}\n\nTraceback:\n{tb}")
        sys.exit(1)
