"""Tira capturas de tela da versão 2 com o Supabase falso, para conferência visual.

Uso:  python testes/capturas_v2.py [pasta_de_saida]
Gera: entrar.png, painel.png, controle.png, transacoes.png, metas.png, config_casa.png, modal_lancamento.png
"""
import http.server
import socketserver
import sys
import threading
from datetime import date
from pathlib import Path

from playwright.sync_api import sync_playwright

RAIZ = Path(__file__).resolve().parents[1]
PORTA = 8766
BASE = f"http://127.0.0.1:{PORTA}/v2/index.html"
MOCK_JS = (RAIZ / "testes" / "mock_supabase.js").read_text(encoding="utf-8")
CONFIG_JS = "window.GPLAN_CONFIG = { supabaseUrl: 'https://mock.supabase.co', supabaseKey: 'mock', nomeDaCasa: 'Casa Teste' };"
SAIDA = Path(sys.argv[1]) if len(sys.argv) > 1 else RAIZ / "testes" / "capturas"


def servidor():
    class Quieto(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = lambda *a, **k: Quieto(*a, directory=str(RAIZ), **k)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORTA), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def rotear(page):
    page.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=MOCK_JS))
    page.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="text/css", body=""))
    page.route("**/config.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=CONFIG_JS))


def lancar(page, valor, descricao, tipo="expense", status="pending", categoria=None, dia=None):
    page.click("#fab")
    page.wait_for_selector("#modal-tx.active")
    page.click("#btn-expense" if tipo == "expense" else "#btn-income")
    page.fill("#tx-amount", valor)
    page.fill("#tx-desc", descricao)
    if dia:
        page.fill("#tx-date", dia)
    page.select_option("#tx-category", categoria or ("food" if tipo == "expense" else "salary"))
    page.click("#btn-status-pending" if status == "pending" else "#btn-status-paid")
    page.click("#form-tx button[type=submit]")
    page.wait_for_function("!document.getElementById('modal-tx').classList.contains('active')")


def main():
    SAIDA.mkdir(parents=True, exist_ok=True)
    httpd = servidor()
    hoje = date.today()
    mes = hoje.strftime("%Y-%m")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, locale="pt-BR", timezone_id="America/Recife", service_workers="block")
        page = ctx.new_page()
        rotear(page)
        page.goto(BASE)
        page.evaluate("localStorage.clear(); sessionStorage.clear();")
        page.reload()
        page.wait_for_selector("#auth-shell:not(.hidden)")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SAIDA / "entrar.png"))

        page.fill("#auth-email", "daniel@teste.com")
        page.fill("#auth-password", "123456")
        page.click("#auth-submit-btn")
        page.wait_for_function("document.getElementById('live-text').textContent.startsWith('Ao vivo')", timeout=10000)

        lancar(page, "520000", "Salário", tipo="income", status="paid", dia=f"{mes}-05")
        lancar(page, "180000", "Aluguel", categoria="home", status="paid", dia=f"{mes}-05")
        lancar(page, "64390", "Supermercado", categoria="food", status="paid", dia=f"{mes}-08")
        lancar(page, "12990", "Internet", categoria="home", status="pending", dia=f"{mes}-20")
        lancar(page, "35000", "Cartão", categoria="credit_card", status="pending", dia=f"{mes}-15")
        lancar(page, "8000", "Farmácia", categoria="health", status="paid", dia=f"{mes}-10")
        page.wait_for_function("document.getElementById('settings-queue-count').textContent === '0'")

        page.evaluate("openPage('dashboard')")
        page.wait_for_timeout(400)
        page.screenshot(path=str(SAIDA / "painel.png"), full_page=True)

        page.evaluate("openPage('control')")
        page.click("[data-control-tab='expense']")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SAIDA / "controle.png"), full_page=True)

        page.evaluate("openPage('transactions')")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SAIDA / "transacoes.png"), full_page=True)

        page.evaluate("openPage('goals')")
        page.click("#page-goals .page-header button.bg-brand\\/15")
        page.fill("#goal-title", "Viagem de férias")
        page.fill("#goal-target", "600000")
        page.fill("#goal-current", "210000")
        page.fill("#goal-deadline", f"{hoje.year + 1}-07")
        page.click("#modal-goal button[type=submit]")
        page.wait_for_timeout(400)
        page.screenshot(path=str(SAIDA / "metas.png"), full_page=True)

        page.evaluate("openPage('settings')")
        page.click("[data-settings-tab='casa']")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SAIDA / "config_casa.png"), full_page=True)

        page.evaluate("openPage('dashboard')")
        page.click("#fab")
        page.wait_for_selector("#modal-tx.active")
        page.wait_for_timeout(400)
        page.screenshot(path=str(SAIDA / "modal_lancamento.png"))

        browser.close()
    httpd.shutdown()
    print("capturas em", SAIDA)


if __name__ == "__main__":
    main()
