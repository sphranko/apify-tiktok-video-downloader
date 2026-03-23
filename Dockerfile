FROM apify/actor-python-playwright:3.12

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install chromium
RUN playwright install-deps chromium

COPY . ./

CMD ["python", "-m", "src.main"]
