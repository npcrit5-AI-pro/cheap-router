// Free Web APIs toolbox: catalog of public, keyless HTTPS APIs the chat can call.
// Every entry: no API key, no account, no signup; documented public/open API.
// url templates use {param} placeholders; only declared params are substituted.
// map() shrinks the upstream response to the useful fields so tool results stay small.
// map() may throw on API-level errors; executeApi() turns that into {ok:false}.
const trunc = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '');
const decodeEnt = (s) => String(s ?? '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const need = (v, what) => { if (v === undefined || v === null || v === '') throw new Error('missing ' + what); return v; };

const APIS = [
  // ---- Weather & environment ----
  { id: 'openmeteo-forecast', name: 'Weather forecast', category: 'Weather', host: 'api.open-meteo.com',
    description: 'When to use: the user asks about current weather or a forecast for a place. Needs latitude/longitude (use a geocoding tool first if you only have a city name).',
    url: 'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,uv_index&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3',
    params: { lat: 'latitude in decimal degrees', lon: 'longitude in decimal degrees' }, example: { lat: '52.52', lon: '13.41' },
    map: (d) => ({ time: d.current.time, temp_c: d.current.temperature_2m, feels_like_c: d.current.apparent_temperature, humidity_pct: d.current.relative_humidity_2m, wind_kmh: d.current.wind_speed_10m, uv_index: d.current.uv_index, weather_code: d.current.weather_code,
      next_days: d.daily.time.map((t, i) => ({ date: t, high_c: d.daily.temperature_2m_max[i], low_c: d.daily.temperature_2m_min[i], precip_prob_pct: d.daily.precipitation_probability_max[i] })) }) },
  { id: 'openmeteo-airquality', name: 'Air quality', category: 'Environment', host: 'air-quality-api.open-meteo.com',
    description: 'When to use: the user asks about air quality, pollution, AQI, PM2.5 or ozone for coordinates.',
    url: 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lat}&longitude={lon}&current=us_aqi,pm2_5,pm10,ozone&timezone=auto',
    params: { lat: 'latitude in decimal degrees', lon: 'longitude in decimal degrees' }, example: { lat: '52.52', lon: '13.41' },
    map: (d) => ({ time: d.current.time, us_aqi: d.current.us_aqi, pm2_5: d.current.pm2_5, pm10: d.current.pm10, ozone: d.current.ozone }) },
  { id: 'openmeteo-geocode', name: 'Place lookup', category: 'Geography', host: 'geocoding-api.open-meteo.com',
    description: 'When to use: turn a city or place name into latitude/longitude for the weather/air-quality tools.',
    url: 'https://geocoding-api.open-meteo.com/v1/search?name={q}&count=5&language=en&format=json',
    params: { q: 'place name, e.g. Paris' }, example: { q: 'Paris' },
    map: (d) => (need(d.results, 'no places found')).slice(0, 5).map((r) => ({ name: r.name, country: r.country, region: r.admin1, lat: r.latitude, lon: r.longitude })) },
  { id: 'sunrise-sunset', name: 'Sunrise and sunset', category: 'Weather', host: 'api.sunrise-sunset.org',
    description: 'When to use: the user asks when the sun rises or sets, day length, or solar noon for coordinates.',
    url: 'https://api.sunrise-sunset.org/json?lat={lat}&lng={lon}&formatted=0',
    params: { lat: 'latitude in decimal degrees', lon: 'longitude in decimal degrees' }, example: { lat: '52.52', lon: '13.41' },
    map: (d) => ({ sunrise: d.results.sunrise, sunset: d.results.sunset, solar_noon: d.results.solar_noon, day_length: d.results.day_length }) },
  { id: 'usgs-quakes', name: 'Recent earthquakes', category: 'Environment', host: 'earthquake.usgs.gov',
    description: 'When to use: the user asks about recent earthquakes, their magnitudes or locations.',
    url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit={limit}&minmagnitude={minmag}&orderby=time',
    params: { limit: 'max quakes to return (default 5)', minmag: 'minimum magnitude (default 5)' }, example: { limit: '5', minmag: '5' },
    map: (d) => ({ count: d.metadata.count, quakes: d.features.slice(0, 8).map((f) => ({ mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time).toISOString(), url: f.properties.url })) }) },
  // ---- Space ----
  { id: 'iss-position', name: 'ISS position', category: 'Space', host: 'api.wheretheiss.at',
    description: 'When to use: the user asks where the International Space Station is right now.',
    url: 'https://api.wheretheiss.at/v1/satellites/25544',
    params: {}, example: {},
    map: (d) => ({ lat: d.latitude, lon: d.longitude, altitude_km: d.altitude, velocity_kmh: d.velocity, visibility: d.visibility, timestamp: new Date(d.timestamp * 1000).toISOString() }) },
  // ---- Crypto & money ----
  { id: 'kraken-ticker', name: 'Crypto price (Kraken)', category: 'Crypto', host: 'api.kraken.com',
    description: 'When to use: the user asks the current price of a cryptocurrency. Pair format like XXBTZUSD (BTC/USD) or XETHZEUR (ETH/EUR).',
    url: 'https://api.kraken.com/0/public/Ticker?pair={pair}',
    params: { pair: 'Kraken pair, e.g. XXBTZUSD for BTC/USD' }, example: { pair: 'XXBTZUSD' },
    map: (d) => { const k = Object.keys(need(d.result, 'unknown pair'))[0], t = d.result[k];
      return { pair: k, ask: t.a[0], bid: t.b[0], last: t.c[0], high_24h: t.h[1], low_24h: t.l[1], volume_24h: t.v[1] }; } },
  { id: 'kraken-ohlc', name: 'Crypto price history', category: 'Crypto', host: 'api.kraken.com',
    description: 'When to use: the user asks how a crypto price moved recently. Returns the last 5 candles.',
    url: 'https://api.kraken.com/0/public/OHLC?pair={pair}&interval={interval}',
    params: { pair: 'Kraken pair, e.g. XXBTZUSD', interval: 'candle size in minutes (default 60)' }, example: { pair: 'XXBTZUSD', interval: '60' },
    map: (d) => { const k = Object.keys(need(d.result, 'unknown pair')).filter((x) => x !== 'last')[0];
      return { pair: k, candles: d.result[k].slice(-5).map((c) => ({ time: new Date(c[0] * 1000).toISOString(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[6] })) }; } },
  { id: 'coingecko-price', name: 'Crypto price (CoinGecko)', category: 'Crypto', host: 'api.coingecko.com',
    description: 'When to use: the user asks the USD/EUR price of a named coin (bitcoin, ethereum, solana...).',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd,eur&include_24hr_change=true',
    params: { ids: 'coin id, e.g. bitcoin (comma-separated for several)' }, example: { ids: 'bitcoin' },
    map: (d) => Object.entries(d).map(([coin, v]) => ({ coin, usd: v.usd, eur: v.eur, usd_24h_change_pct: v.usd_24h_change })) },
  { id: 'coinpaprika-ticker', name: 'Coin stats', category: 'Crypto', host: 'api.coinpaprika.com',
    description: 'When to use: the user asks for market cap, rank or 24h stats of a coin. Coin id like btc-bitcoin or eth-ethereum.',
    url: 'https://api.coinpaprika.com/v1/tickers/{coin}',
    params: { coin: 'coin id, e.g. btc-bitcoin' }, example: { coin: 'btc-bitcoin' },
    map: (d) => ({ name: d.name, symbol: d.symbol, rank: d.rank, price_usd: d.quotes?.USD?.price, change_24h_pct: d.quotes?.USD?.percent_change_24h, market_cap_usd: d.quotes?.USD?.market_cap, volume_24h_usd: d.quotes?.USD?.volume_24h }) },
  { id: 'coinbase-spot', name: 'Crypto spot price', category: 'Crypto', host: 'api.coinbase.com',
    description: 'When to use: a quick spot price for a crypto/fiat pair like BTC-USD or ETH-EUR.',
    url: 'https://api.coinbase.com/v2/prices/{pair}/spot',
    params: { pair: 'pair like BTC-USD' }, example: { pair: 'BTC-USD' },
    map: (d) => ({ base: d.data.base, currency: d.data.currency, amount: d.data.amount }) },
  { id: 'erapi-rates', name: 'Exchange rate', category: 'Money', host: 'open.er-api.com',
    description: 'When to use: convert between fiat currencies or get the rate for a pair like USD to EUR. Use 3-letter codes.',
    url: 'https://open.er-api.com/v6/latest/{base}',
    params: { base: 'base currency code, e.g. USD', target: 'target currency code, e.g. EUR' }, example: { base: 'USD', target: 'EUR' },
    map: (d, p = {}) => { const majors = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY'];
      const want = [...new Set([...majors, String(p.target || '').toUpperCase()])].filter((c) => d.rates[c] !== undefined);
      return { base: d.base_code, date: d.time_last_update_utc, target: p.target, rate: p.target ? d.rates[String(p.target).toUpperCase()] : undefined, majors: Object.fromEntries(want.map((c) => [c, d.rates[c]])) }; } },
  { id: 'frankfurter-convert', name: 'Currency conversion (ECB)', category: 'Money', host: 'api.frankfurter.dev',
    description: 'When to use: convert an amount between currencies using European Central Bank reference rates.',
    url: 'https://api.frankfurter.dev/v1/latest?base={base}&symbols={symbols}',
    params: { base: 'base currency code, e.g. EUR', symbols: 'comma-separated targets, e.g. USD,GBP' }, example: { base: 'EUR', symbols: 'USD,GBP' },
    map: (d) => ({ base: d.base, date: d.date, rates: d.rates }) },
  // ---- Countries & geography ----
  { id: 'zippopotam', name: 'Postcode lookup', category: 'Geography', host: 'api.zippopotam.us',
    description: 'When to use: the user gives a postcode/ZIP and country and wants the city, state and coordinates.',
    url: 'https://api.zippopotam.us/{country}/{zip}',
    params: { country: '2-letter country code, e.g. us', zip: 'postcode, e.g. 90210' }, example: { country: 'us', zip: '90210' },
    map: (d) => ({ postcode: d['post code'], country: d.country, places: d.places.map((p) => ({ name: p['place name'], state: p.state, lat: p.latitude, lon: p.longitude })) }) },
  { id: 'worldbank-population', name: 'Country population trend', category: 'Countries', host: 'api.worldbank.org',
    description: 'When to use: the user asks for a country\'s population or how it changed. Country is a 3-letter code (DEU, USA, JPN).',
    url: 'https://api.worldbank.org/v2/country/{code}/indicator/SP.POP.TOTL?format=json&per_page=8',
    params: { code: '3-letter country code, e.g. DEU' }, example: { code: 'DEU' },
    map: (d) => (d[1] || []).filter((e) => e.value !== null).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3).map((e) => ({ year: e.date, population: e.value })) },
  { id: 'worldbank-gdp', name: 'Country GDP trend', category: 'Countries', host: 'api.worldbank.org',
    description: 'When to use: the user asks for a country\'s GDP in USD. Country is a 3-letter code.',
    url: 'https://api.worldbank.org/v2/country/{code}/indicator/NY.GDP.MKTP.CD?format=json&per_page=8',
    params: { code: '3-letter country code, e.g. DEU' }, example: { code: 'DEU' },
    map: (d) => (d[1] || []).filter((e) => e.value !== null).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3).map((e) => ({ year: e.date, gdp_usd: e.value })) },
  { id: 'worldbank-country', name: 'Country profile', category: 'Countries', host: 'api.worldbank.org',
    description: 'When to use: capital, region and income level of a country (3-letter code).',
    url: 'https://api.worldbank.org/v2/country/{code}?format=json',
    params: { code: '3-letter country code, e.g. DEU' }, example: { code: 'DEU' },
    map: (d) => { const c = d[1][0]; return { name: c.name, capital: c.capitalCity, region: c.region?.value, income: c.incomeLevel?.value, lat: c.latitude, lon: c.longitude }; } },
  // ---- Network: IP & DNS ----
  { id: 'ipwhois', name: 'IP geolocation', category: 'Network', host: 'ipwho.is',
    description: 'When to use: the user asks where an IP address is located (country, city, ISP).',
    url: 'https://ipwho.is/{ip}',
    params: { ip: 'IPv4 address, e.g. 8.8.8.8' }, example: { ip: '8.8.8.8' },
    map: (d) => { if (d.success === false) throw new Error(d.message || 'lookup failed'); return { ip: d.ip, country: d.country, city: d.city, region: d.region, lat: d.latitude, lon: d.longitude, isp: d.connection?.isp, timezone: d.timezone?.utc }; } },
  { id: 'dns-google', name: 'DNS lookup', category: 'Network', host: 'dns.google',
    description: 'When to use: the user asks what DNS records (A, MX, TXT, NS...) a domain has.',
    url: 'https://dns.google/resolve?name={name}&type={type}',
    params: { name: 'domain, e.g. example.com', type: 'record type: A, AAAA, MX, TXT, NS or CNAME' }, example: { name: 'example.com', type: 'A' },
    map: (d) => { if (d.Status !== 0) throw new Error('DNS error status ' + d.Status); return { domain: d.Question?.[0]?.name, records: (d.Answer || []).slice(0, 8).map((a) => ({ type: a.type, ttl: a.TTL, data: a.data })) }; } },
  // ---- Words & language ----
  { id: 'datamuse-synonyms', name: 'Synonyms', category: 'Words', host: 'api.datamuse.com',
    description: 'When to use: the user wants synonyms or words with a similar meaning.',
    url: 'https://api.datamuse.com/words?ml={word}&max=8',
    params: { word: 'word, e.g. happy' }, example: { word: 'happy' },
    map: (d) => d.slice(0, 8).map((w) => w.word) },
  { id: 'datamuse-rhymes', name: 'Rhymes', category: 'Words', host: 'api.datamuse.com',
    description: 'When to use: the user wants words that rhyme (for poems, lyrics, slogans).',
    url: 'https://api.datamuse.com/words?rel_rhy={word}&max=8',
    params: { word: 'word, e.g. cat' }, example: { word: 'cat' },
    map: (d) => d.slice(0, 8).map((w) => w.word) },
  { id: 'datamuse-soundlike', name: 'Sound-alike words', category: 'Words', host: 'api.datamuse.com',
    description: 'When to use: the user wants words that sound similar (puns, name ideas, spelling help).',
    url: 'https://api.datamuse.com/words?sl={word}&max=8',
    params: { word: 'word, e.g. circus' }, example: { word: 'circus' },
    map: (d) => d.slice(0, 8).map((w) => w.word) },
  { id: 'urban-define', name: 'Slang definitions', category: 'Words', host: 'api.urbandictionary.com',
    description: 'When to use: the user asks what internet slang means. Definitions are crowdsourced and can be crude.',
    url: 'https://api.urbandictionary.com/v0/define?term={term}',
    params: { term: 'slang term, e.g. yeet' }, example: { term: 'computer' },
    map: (d) => { const t = need((d.list || [])[0], 'no definition found'); return { definition: trunc(stripTags(t.definition).replace(/[\[\]]/g, ''), 400), example: trunc(stripTags(t.example).replace(/[\[\]]/g, ''), 300), thumbs_up: t.thumbs_up, thumbs_down: t.thumbs_down }; } },
  { id: 'mymemory-translate', name: 'Translate text', category: 'Words', host: 'api.mymemory.translated.net',
    description: 'When to use: translate a short text between languages. Pair format like en|fr, en|de, es|en.',
    url: 'https://api.mymemory.translated.net/get?q={text}&langpair={pair}',
    params: { text: 'text to translate', pair: 'language pair like en|fr' }, example: { text: 'Hello world', pair: 'en|fr' },
    map: (d) => ({ translated: d.responseData?.translatedText, match_quality: d.responseData?.match }) },
  // ---- Fun ----
  { id: 'jokeapi', name: 'Joke by topic', category: 'Fun', host: 'v2.jokeapi.dev',
    description: 'When to use: the user wants a joke about a topic (Programming, Misc, Pun, Spooky, Christmas).',
    url: 'https://v2.jokeapi.dev/joke/{category}?type=single',
    params: { category: 'Any, Programming, Misc, Pun, Spooky or Christmas' }, example: { category: 'Programming' },
    map: (d) => { if (d.error) throw new Error('no joke'); return { category: d.category, joke: d.joke }; } },
  { id: 'dadjoke', name: 'Dad joke', category: 'Fun', host: 'icanhazdadjoke.com',
    description: 'When to use: the user wants a random dad joke.',
    url: 'https://icanhazdadjoke.com/',
    params: {}, example: {},
    headers: { Accept: 'application/json', 'User-Agent': 'cheap-router' },
    map: (d) => ({ joke: d.joke }) },
  { id: 'chucknorris-random', name: 'Chuck Norris fact', category: 'Fun', host: 'api.chucknorris.io',
    description: 'When to use: the user wants a random Chuck Norris joke.',
    url: 'https://api.chucknorris.io/jokes/random',
    params: {}, example: {},
    map: (d) => ({ joke: d.value }) },
  { id: 'advice', name: 'Random advice', category: 'Fun', host: 'api.adviceslip.com',
    description: 'When to use: the user asks for a piece of advice or a motivational one-liner.',
    url: 'https://api.adviceslip.com/advice',
    params: {}, example: {},
    map: (d) => ({ advice: d.slip?.advice }) },
  { id: 'yesno', name: 'Yes or no oracle', category: 'Fun', host: 'yesno.wtf',
    description: 'When to use: the user wants a playful yes/no/maybe answer to a question.',
    url: 'https://yesno.wtf/api',
    params: {}, example: {},
    map: (d) => ({ answer: d.answer, image: d.image }) },
  { id: 'agify', name: 'Guess age from name', category: 'People', host: 'api.agify.io',
    description: 'When to use: the user wonders how old someone with a first name typically is (statistical guess).',
    url: 'https://api.agify.io/?name={name}',
    params: { name: 'first name, e.g. Michael' }, example: { name: 'Michael' },
    map: (d) => ({ name: d.name, guessed_age: d.age, samples: d.count }) },
  { id: 'nationalize', name: 'Guess nationality from name', category: 'People', host: 'api.nationalize.io',
    description: 'When to use: the user wonders which countries a first name most likely comes from.',
    url: 'https://api.nationalize.io/?name={name}',
    params: { name: 'first name, e.g. Yuki' }, example: { name: 'Yuki' },
    map: (d) => ({ name: d.name, top_countries: (d.country || []).slice(0, 3).map((c) => ({ code: c.country_id, probability: c.probability })) }) },
  { id: 'randomuser', name: 'Random person', category: 'People', host: 'randomuser.me',
    description: 'When to use: the user needs a fake person profile (name, location, email) for testing or examples.',
    url: 'https://randomuser.me/api/?results={n}&inc=name,location,email,nat,picture',
    params: { n: 'how many profiles, 1-5' }, example: { n: '1' },
    map: (d) => d.results.map((p) => ({ name: `${p.name.first} ${p.name.last}`, country: p.location.country, city: p.location.city, email: p.email, nationality: p.nat })) },
  // ---- Food ----
  { id: 'meal-search', name: 'Recipe search', category: 'Food', host: 'www.themealdb.com',
    description: 'When to use: the user wants a recipe or meal idea with an ingredient or dish name.',
    url: 'https://www.themealdb.com/api/json/v1/1/search.php?s={q}',
    params: { q: 'dish or ingredient, e.g. chicken' }, example: { q: 'chicken' },
    map: (d) => (need(d.meals, 'no recipes found')).slice(0, 3).map((m) => ({ name: m.strMeal, category: m.strCategory, area: m.strArea, instructions: trunc(m.strInstructions, 350) })) },
  { id: 'meal-random', name: 'Random recipe', category: 'Food', host: 'www.themealdb.com',
    description: 'When to use: the user wants a surprise recipe suggestion.',
    url: 'https://www.themealdb.com/api/json/v1/1/random.php',
    params: {}, example: {},
    map: (d) => { const m = d.meals[0]; return { name: m.strMeal, category: m.strCategory, area: m.strArea, instructions: trunc(m.strInstructions, 350) }; } },
  { id: 'cocktail-search', name: 'Cocktail recipes', category: 'Food', host: 'www.thecocktaildb.com',
    description: 'When to use: the user wants a cocktail recipe by name.',
    url: 'https://www.thecocktaildb.com/api/json/v1/1/search.php?s={q}',
    params: { q: 'cocktail name, e.g. margarita' }, example: { q: 'margarita' },
    map: (d) => (need(d.drinks, 'no cocktails found')).slice(0, 3).map((x) => { const ingr = []; for (let i = 1; i <= 6; i++) if (x['strIngredient' + i]) ingr.push(`${x['strIngredient' + i]}${x['strMeasure' + i] ? ' (' + x['strMeasure' + i].trim() + ')' : ''}`);
      return { name: x.strDrink, category: x.strCategory, alcoholic: x.strAlcoholic, glass: x.strGlass, ingredients: ingr, instructions: trunc(x.strInstructions, 300) }; }) },
  { id: 'openfoodfacts', name: 'Food product by barcode', category: 'Food', host: 'world.openfoodfacts.org',
    description: 'When to use: the user gives a barcode (EAN) and wants to know what product it is and its nutrition scores.',
    url: 'https://world.openfoodfacts.org/api/v2/product/{barcode}.json',
    params: { barcode: 'EAN barcode, e.g. 3017620422003' }, example: { barcode: '3017620422003' },
    map: (d) => { if (d.status !== 1) throw new Error('product not found'); const p = d.product;
      return { name: p.product_name, brands: p.brands, quantity: p.quantity, nutriscore: p.nutriscore_grade, ecoscore: p.ecoscore_grade, nova: p.nova_group }; } },
  // ---- Animals & nature ----
  { id: 'dog-breeds', name: 'Dog breeds', category: 'Animals', host: 'dog.ceo',
    description: 'When to use: the user asks what dog breeds exist.',
    url: 'https://dog.ceo/api/breeds/list/all',
    params: {}, example: {},
    map: (d) => { const breeds = Object.keys(d.message); return { count: breeds.length, breeds: breeds.slice(0, 40) }; } },
  { id: 'dog-random', name: 'Random dog photo', category: 'Animals', host: 'dog.ceo',
    description: 'When to use: the user wants a random dog picture URL.',
    url: 'https://dog.ceo/api/breeds/image/random',
    params: {}, example: {},
    map: (d) => ({ image_url: d.message }) },
  { id: 'dog-facts', name: 'Dog facts', category: 'Animals', host: 'dog-api.kinduff.com',
    description: 'When to use: the user wants fun facts about dogs.',
    url: 'https://dog-api.kinduff.com/api/facts?number={n}',
    params: { n: 'how many facts, 1-5' }, example: { n: '3' },
    map: (d) => ({ facts: d.facts }) },
  { id: 'catfact', name: 'Cat fact', category: 'Animals', host: 'catfact.ninja',
    description: 'When to use: the user wants a random cat fact.',
    url: 'https://catfact.ninja/fact',
    params: {}, example: {},
    map: (d) => ({ fact: d.fact }) },
  { id: 'inat-observations', name: 'Wildlife sightings', category: 'Nature', host: 'api.inaturalist.org',
    description: 'When to use: the user asks about recent real-world sightings of a species (e.g. red fox, monarch).',
    url: 'https://api.inaturalist.org/v1/observations?taxon_name={species}&per_page=3&order=desc&order_by=created_at',
    params: { species: 'species name, e.g. red fox' }, example: { species: 'red fox' },
    map: (d) => (need(d.results, 'no sightings')).slice(0, 3).map((o) => ({ species: o.taxon?.preferred_common_name || o.species_guess, observed_on: o.observed_on, place: o.place_guess, link: o.uri })) },
  // ---- Books ----
  { id: 'openlibrary-search', name: 'Book search', category: 'Books', host: 'openlibrary.org',
    description: 'When to use: the user looks for a book by title or topic (author and first-published year included).',
    url: 'https://openlibrary.org/search.json?q={q}&limit=5',
    params: { q: 'search terms, e.g. dune' }, example: { q: 'dune' },
    map: (d) => d.docs.slice(0, 5).map((b) => ({ title: b.title, author: (b.author_name || [])[0], first_published: b.first_publish_year })) },
  { id: 'openlibrary-isbn', name: 'Book by ISBN', category: 'Books', host: 'openlibrary.org',
    description: 'When to use: the user gives an ISBN and wants the book details.',
    url: 'https://openlibrary.org/isbn/{isbn}.json',
    params: { isbn: 'ISBN, e.g. 9780140328721' }, example: { isbn: '9780140328721' },
    map: (d) => ({ title: d.title, publish_date: d.publish_date, pages: d.number_of_pages, publishers: d.publishers }) },
  { id: 'loc-books', name: 'Library of Congress books', category: 'Books', host: 'www.loc.gov',
    description: 'When to use: the user looks for books or printed material in the Library of Congress catalog.',
    url: 'https://www.loc.gov/books/?q={q}&fo=json&c=5',
    params: { q: 'search terms, e.g. dune' }, example: { q: 'dune' },
    map: (d) => (need(d.results, 'nothing found')).slice(0, 5).map((b) => ({ title: b.title, date: b.date, creator: (b.contributor || [])[0], url: b.url })) },
  { id: 'ia-texts', name: 'Public-domain texts', category: 'Books', host: 'archive.org',
    description: 'When to use: the user wants free public-domain ebooks or texts from the Internet Archive, with links to read them.',
    url: 'https://archive.org/advancedsearch.php?q={q}%20AND%20mediatype:texts&fl[]=identifier&fl[]=title&fl[]=creator&rows=5&output=json',
    params: { q: 'search terms, e.g. sherlock holmes' }, example: { q: 'sherlock holmes' },
    map: (d) => (need(d.response?.docs, 'nothing found')).slice(0, 5).map((x) => ({ title: x.title, creator: x.creator, read: `https://archive.org/details/${x.identifier}` })) },
  { id: 'wikisource-search', name: 'Wikisource search', category: 'Books', host: 'en.wikisource.org',
    description: 'When to use: the user looks for free source texts (books, essays, historical documents) on Wikisource.',
    url: 'https://en.wikisource.org/w/api.php?action=query&list=search&srsearch={q}&format=json&srlimit=5',
    params: { q: 'search terms, e.g. sherlock' }, example: { q: 'sherlock' },
    map: (d) => d.query.search.slice(0, 5).map((s) => ({ title: s.title, snippet: trunc(stripTags(s.snippet), 200) })) },
  { id: 'wikibooks-search', name: 'Wikibooks search', category: 'Books', host: 'en.wikibooks.org',
    description: 'When to use: the user looks for free open textbooks or how-to books on Wikibooks.',
    url: 'https://en.wikibooks.org/w/api.php?action=query&list=search&srsearch={q}&format=json&srlimit=5',
    params: { q: 'search terms, e.g. python' }, example: { q: 'python' },
    map: (d) => d.query.search.slice(0, 5).map((s) => ({ title: s.title, snippet: trunc(stripTags(s.snippet), 200) })) },
  { id: 'openlibrary-authors', name: 'Author lookup', category: 'Books', host: 'openlibrary.org',
    description: 'When to use: the user asks about an author (top work, work count, dates). Returns the author id for the books-by-author tool.',
    url: 'https://openlibrary.org/search/authors.json?q={q}',
    params: { q: 'author name, e.g. twain' }, example: { q: 'twain' },
    map: (d) => (need(d.docs, 'no authors found')).slice(0, 5).map((a) => ({ name: a.name, id: String(a.key || '').split('/').pop(), born: a.birth_date, died: a.death_date, top_work: a.top_work, works: a.work_count })) },
  { id: 'openlibrary-author-works', name: 'Books by author', category: 'Books', host: 'openlibrary.org',
    description: 'When to use: list works by an Open Library author id like OL23919A (get it from author lookup first, without any /authors/ prefix).',
    url: 'https://openlibrary.org/authors/{id}/works.json?limit=8',
    params: { id: 'author id, e.g. OL9937375A' }, example: { id: 'OL9937375A' },
    map: (d) => (need(d.entries, 'no works found')).slice(0, 8).map((w) => w.title) },
  { id: 'openlibrary-subjects', name: 'Browse by genre', category: 'Books', host: 'openlibrary.org',
    description: 'When to use: the user wants popular books in a genre or subject like science_fiction, mystery or romance (use underscores).',
    url: 'https://openlibrary.org/subjects/{subject}.json?limit=8',
    params: { subject: 'subject key, e.g. science_fiction' }, example: { subject: 'science_fiction' },
    map: (d) => ({ subject: d.name, works: (need(d.works, 'no works found')).slice(0, 8).map((w) => ({ title: w.title, authors: (w.authors || []).map((a) => a.name).join(', '), editions: w.edition_count })) }) },
  { id: 'crossref-books', name: 'Published books', category: 'Books', host: 'api.crossref.org',
    description: 'When to use: the user looks for formally published books on a topic (publisher and DOI included).',
    url: 'https://api.crossref.org/works?query={q}&filter=type:book&rows=3',
    params: { q: 'search terms, e.g. sherlock holmes' }, example: { q: 'sherlock holmes' },
    headers: { 'User-Agent': 'cheap-router' },
    map: (d) => (need(d.message?.items, 'no books found')).slice(0, 3).map((w) => ({ title: (w.title || [])[0], authors: (w.author || []).slice(0, 2).map((a) => [a.given, a.family].filter(Boolean).join(' ')), publisher: w.publisher, published: w.created?.['date-time']?.slice(0, 10), doi: w.DOI })) },
  { id: 'inventaire-works', name: 'Book entities', category: 'Books', host: 'inventaire.io',
    description: 'When to use: identify a book work (Wikidata-backed entity with a one-line description of what the book is).',
    url: 'https://inventaire.io/api/search?search={q}&types=works&limit=5',
    params: { q: 'book title, e.g. dune' }, example: { q: 'dune' },
    map: (d) => (need(d.results, 'nothing found')).slice(0, 5).map((r) => ({ title: r.label, about: r.description, ref: r.uri })) },
  // ---- TV & games ----
  { id: 'tvmaze-search', name: 'TV show search', category: 'TV', host: 'api.tvmaze.com',
    description: 'When to use: the user asks about a TV show (rating, years, genres, plot).',
    url: 'https://api.tvmaze.com/search/shows?q={q}',
    params: { q: 'show name, e.g. breaking bad' }, example: { q: 'breaking bad' },
    map: (d) => d.slice(0, 3).map((x) => ({ name: x.show.name, premiered: x.show.premiered, rating: x.show.rating?.average, genres: x.show.genres, summary: trunc(stripTags(x.show.summary), 250) })) },
  { id: 'pokeapi-pokemon', name: 'Pokemon facts', category: 'Games', host: 'pokeapi.co',
    description: 'When to use: the user asks about a Pokemon (habitat, flavor text, whether it is legendary).',
    url: 'https://pokeapi.co/api/v2/pokemon-species/{name}',
    params: { name: 'pokemon name or id, e.g. pikachu' }, example: { name: 'pikachu' },
    map: (d) => ({ name: d.name, id: d.id, habitat: d.habitat?.name, legendary: d.is_legendary, mythical: d.is_mythical, genera: (d.genera || []).find((g) => g.language?.name === 'en')?.genus, flavor: trunc(((d.flavor_text_entries || []).find((f) => f.language?.name === 'en')?.flavor_text || ''), 300), capture_rate: d.capture_rate }) },
  { id: 'pokeapi-type', name: 'Pokemon by type', category: 'Games', host: 'pokeapi.co',
    description: 'When to use: the user asks which Pokemon have a type like electric, fire or water.',
    url: 'https://pokeapi.co/api/v2/type/{type}',
    params: { type: 'type name, e.g. electric' }, example: { type: 'electric' },
    map: (d) => ({ count: d.pokemon.length, sample: d.pokemon.slice(0, 10).map((p) => p.pokemon.name) }) },
  { id: 'rickmorty-character', name: 'Rick and Morty character', category: 'TV', host: 'rickandmortyapi.com',
    description: 'When to use: the user asks about a Rick and Morty character.',
    url: 'https://rickandmortyapi.com/api/character/?name={name}',
    params: { name: 'character name, e.g. rick' }, example: { name: 'rick' },
    map: (d) => { const c = need(d.results, 'character not found')[0]; return { name: c.name, status: c.status, species: c.species, gender: c.gender, origin: c.origin?.name, episodes: c.episode?.length }; } },
  { id: 'cheapshark-deals', name: 'Cheap game deals', category: 'Games', host: 'www.cheapshark.com',
    description: 'When to use: the user wants cheap PC game deals under a max price (Steam store).',
    url: 'https://www.cheapshark.com/api/1.0/deals?storeID=1&upperPrice={maxprice}&pageSize=5',
    params: { maxprice: 'max price in USD, e.g. 5' }, example: { maxprice: '5' },
    headers: { 'User-Agent': 'cheap-router' },
    map: (d) => d.slice(0, 5).map((g) => ({ title: g.title, sale_usd: g.salePrice, normal_usd: g.normalPrice, savings_pct: Math.round(+g.savings), rating: g.steamRatingText })) },
  // ---- Music ----
  { id: 'itunes-search', name: 'Music search', category: 'Music', host: 'itunes.apple.com',
    description: 'When to use: the user looks for a song, artist or album (iTunes catalog).',
    url: 'https://itunes.apple.com/search?term={q}&media={media}&limit=5',
    params: { q: 'search terms, e.g. beatles', media: 'music, podcast, audiobook or all' }, example: { q: 'beatles', media: 'music' },
    map: (d) => (need(d.results, 'nothing found')).slice(0, 5).map((t) => ({ track: t.trackName, artist: t.artistName, album: t.collectionName, genre: t.primaryGenreName })) },
  { id: 'lyrics-ovh', name: 'Song lyrics', category: 'Music', host: 'api.lyrics.ovh',
    description: 'When to use: the user wants the lyrics of a song by artist and title.',
    url: 'https://api.lyrics.ovh/v1/{artist}/{title}',
    params: { artist: 'artist, e.g. coldplay', title: 'song title, e.g. yellow' }, example: { artist: 'coldplay', title: 'yellow' },
    map: (d) => ({ lyrics: trunc(need(d.lyrics, 'lyrics not found'), 900) }) },
  // ---- Art ----
  { id: 'cleveland-art', name: 'Museum artwork search', category: 'Art', host: 'openaccess-api.clevelandart.org',
    description: 'When to use: the user asks about artworks by title or artist (Cleveland Museum of Art open-access collection).',
    url: 'https://openaccess-api.clevelandart.org/api/artworks/?q={q}&limit=5',
    params: { q: 'search terms, e.g. monet' }, example: { q: 'monet' },
    map: (d) => (need(d.data, 'no artworks found')).slice(0, 5).map((a) => ({ title: a.title, artist: String((a.creators || [])[0]?.description || '').split(' (')[0], date: a.creation_date, technique: a.technique })) },
  { id: 'met-object', name: 'Met Museum object', category: 'Art', host: 'collectionapi.metmuseum.org',
    description: 'When to use: details for one Met object by id (437133 is Wheat Field with Cypresses).',
    url: 'https://collectionapi.metmuseum.org/public/collection/v1/objects/{id}',
    params: { id: 'object id, e.g. 437133' }, example: { id: '437133' },
    map: (d) => ({ title: d.title, artist: d.artistDisplayName, date: d.objectDate, medium: d.medium, culture: d.culture, image: d.primaryImageSmall }) },
  // ---- News & dev ----
  { id: 'hn-search', name: 'Hacker News search', category: 'News', host: 'hn.algolia.com',
    description: 'When to use: the user asks about tech news or discussions on a topic (Hacker News stories).',
    url: 'https://hn.algolia.com/api/v1/search?query={q}&tags=story',
    params: { q: 'search terms, e.g. rust' }, example: { q: 'rust' },
    map: (d) => d.hits.slice(0, 5).map((h) => ({ title: h.title, points: h.points, author: h.author, comments: h.num_comments, url: h.url })) },
  { id: 'github-repo', name: 'GitHub repo info', category: 'Dev', host: 'api.github.com',
    description: 'When to use: the user asks about a GitHub repository (stars, language, description). Format owner/name.',
    url: 'https://api.github.com/repos/{repo}',
    params: { repo: 'owner/name, e.g. octocat/Hello-World' }, example: { repo: 'octocat/Hello-World' },
    headers: { 'User-Agent': 'cheap-router' },
    map: (d) => { if (d.message && !d.full_name) throw new Error(d.message); return { name: d.full_name, description: trunc(d.description, 250), stars: d.stargazers_count, forks: d.forks_count, language: d.language, updated: d.updated_at }; } },
  { id: 'stackexchange-search', name: 'Stack Overflow search', category: 'Dev', host: 'api.stackexchange.com',
    description: 'When to use: the user has a programming question that Stack Overflow may already answer.',
    url: 'https://api.stackexchange.com/2.3/search?order=desc&sort=votes&intitle={q}&site=stackoverflow',
    params: { q: 'question keywords, e.g. python list comprehension' }, example: { q: 'python list comprehension' },
    map: (d) => (need(d.items, 'no questions found')).slice(0, 3).map((x) => ({ title: decodeEnt(x.title), score: x.score, answers: x.answer_count, answered: x.is_answered, link: x.link })) },
  { id: 'pypi-info', name: 'Python package info', category: 'Dev', host: 'pypi.org',
    description: 'When to use: the user asks about a Python package (latest version, summary, Python requirement).',
    url: 'https://pypi.org/pypi/{package}/json',
    params: { package: 'package name, e.g. requests' }, example: { package: 'requests' },
    map: (d) => ({ name: d.info.name, version: d.info.version, summary: d.info.summary, author: d.info.author, requires_python: d.info.requires_python, home: d.info.home_page }) },
  { id: 'npm-info', name: 'npm package info', category: 'Dev', host: 'registry.npmjs.org',
    description: 'When to use: the user asks about a JavaScript/npm package (latest version, description, license).',
    url: 'https://registry.npmjs.org/{package}/latest',
    params: { package: 'package name, e.g. express' }, example: { package: 'express' },
    map: (d) => ({ name: d.name, version: d.version, description: trunc(d.description, 250), license: d.license }) },
  // ---- Science ----
  { id: 'openalex-search', name: 'Research papers', category: 'Science', host: 'api.openalex.org',
    description: 'When to use: the user asks about academic research on a topic (titles, authors, citation counts).',
    url: 'https://api.openalex.org/works?search={q}&per-page=3',
    params: { q: 'search terms, e.g. crispr' }, example: { q: 'crispr' },
    headers: { 'User-Agent': 'cheap-router' },
    map: (d) => (need(d.results, 'no papers found')).slice(0, 3).map((w) => ({ title: w.title, year: w.publication_year, cited_by: w.cited_by_count, authors: (w.authorships || []).slice(0, 3).map((a) => a.author?.display_name), doi: w.doi })) },
  { id: 'arxiv-search', name: 'Preprint search', category: 'Science', host: 'export.arxiv.org',
    description: 'When to use: the user wants recent open-access preprints with abstracts (arXiv, newest first).',
    url: 'https://export.arxiv.org/api/query?search_query=all:{q}&max_results=3&sortBy=submittedDate',
    params: { q: 'search terms, e.g. quantum computing' }, example: { q: 'quantum computing' },
    map: (d) => { const entries = String(d).split('<entry>').slice(1); if (!entries.length) throw new Error('no preprints found');
      const clean = (s) => decodeEnt(stripTags(s)).replace(/\s+/g, ' ').trim();
      const tag = (b, t) => { const m = b.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')); return m ? clean(m[1]) : ''; };
      const authors = (b) => [...b.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()).slice(0, 3);
      return entries.slice(0, 3).map((b) => ({ title: trunc(tag(b, 'title'), 200), authors: authors(b), published: tag(b, 'published').slice(0, 10), summary: trunc(tag(b, 'summary'), 400), link: tag(b, 'id') })); } },
  { id: 'pubchem-compound', name: 'Chemical info', category: 'Science', host: 'pubchem.ncbi.nlm.nih.gov',
    description: 'When to use: the user asks about a chemical compound (formula, weight, SMILES).',
    url: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/JSON',
    params: { name: 'compound name, e.g. caffeine' }, example: { name: 'caffeine' },
    map: (d) => { const p = need(d.PropertyTable?.Properties, 'compound not found')[0]; return { formula: p.MolecularFormula, weight: p.MolecularWeight, iupac: p.IUPACName, smiles: p.CanonicalSMILES }; } },
  { id: 'uniprot-search', name: 'Protein info', category: 'Science', host: 'rest.uniprot.org',
    description: 'When to use: the user asks about a protein or gene (accession, organism, length).',
    url: 'https://rest.uniprot.org/uniprotkb/search?query={q}&fields=accession,gene_names,organism_name,protein_name,length&format=json&size=3',
    params: { q: 'query, e.g. insulin human' }, example: { q: 'insulin human' },
    map: (d) => (need(d.results, 'no proteins found')).slice(0, 3).map((p) => ({ accession: p.primaryAccession, gene: p.genes?.[0]?.geneName?.value, organism: p.organism?.scientificName, protein: p.proteinDescription?.recommendedName?.fullName?.value, length: p.sequence?.length })) },
  // ---- Time & holidays ----
  { id: 'timeapi', name: 'Time and date info', category: 'Time', host: 'timeapi.io',
    description: 'When to use: current date/time plus day-of-week and day-of-year for a timezone.',
    url: 'https://timeapi.io/api/time/current/zone?timeZone={zone}',
    params: { zone: 'IANA zone, e.g. America/New_York' }, example: { zone: 'America/New_York' },
    map: (d) => ({ datetime: d.dateTime, date: d.date, day_of_week: d.dayOfWeek, day_of_year: d.dayOfYear, dst: d.dstActive }) },
  { id: 'nager-holidays', name: 'Public holidays', category: 'Holidays', host: 'date.nager.at',
    description: 'When to use: the user asks about public holidays in a country for a year. Country is a 2-letter code.',
    url: 'https://date.nager.at/api/v3/publicholidays/{year}/{country}',
    params: { year: 'year, e.g. 2025', country: '2-letter code, e.g. US' }, example: { year: '2025', country: 'US' },
    map: (d) => ({ count: d.length, holidays: d.slice(0, 6).map((h) => ({ date: h.date, local: h.localName, name: h.name })) }) },
  // ---- Health ----
  { id: 'disease-country', name: 'COVID stats by country', category: 'Health', host: 'disease.sh',
    description: 'When to use: the user asks for COVID case/death counts for a country.',
    url: 'https://disease.sh/v3/covid-19/countries/{country}?strict=true',
    params: { country: 'country name or code, e.g. USA' }, example: { country: 'USA' },
    map: (d) => ({ country: d.country, cases: d.cases, deaths: d.deaths, recovered: d.recovered, active: d.active, updated: new Date(d.updated).toISOString() }) },
  { id: 'openfda-label', name: 'Drug label info', category: 'Health', host: 'api.fda.gov',
    description: 'When to use: the user asks what a drug is for, its purpose or warnings (FDA label, brand name like aspirin).',
    url: 'https://api.fda.gov/drug/label.json?search=openfda.brand_name:{drug}&limit=1',
    params: { drug: 'brand name, e.g. aspirin' }, example: { drug: 'aspirin' },
    map: (d) => { const r = need(d.results, 'drug not found')[0]; return { brand: r.openfda?.brand_name?.[0], generic: (r.openfda?.generic_name || [])[0], purpose: trunc((r.purpose || [])[0], 300), warnings: trunc((r.warnings || [])[0], 300) }; } },
  // ---- Transport ----
  { id: 'transport-ch-connections', name: 'Swiss train connections', category: 'Transport', host: 'transport.opendata.ch',
    description: 'When to use: the user asks for train connections between two Swiss stations.',
    url: 'https://transport.opendata.ch/v1/connections?from={from}&to={to}&limit=3',
    params: { from: 'station, e.g. Zurich', to: 'station, e.g. Bern' }, example: { from: 'Zurich', to: 'Bern' },
    map: (d) => (need(d.connections, 'no connections found')).slice(0, 3).map((c) => ({ from: `${c.from?.station?.name} ${c.from?.departure || ''}`, to: `${c.to?.station?.name} ${c.to?.arrival || ''}`, duration: c.duration, transfers: c.transfers })) },
  { id: 'remotive-jobs', name: 'Remote jobs', category: 'Jobs', host: 'remotive.com',
    description: 'When to use: the user looks for remote jobs by keyword.',
    url: 'https://remotive.com/api/remote-jobs?search={q}&limit=5',
    params: { q: 'keyword, e.g. python' }, example: { q: 'python' },
    map: (d) => ({ count: d['job-count'], jobs: (d.jobs || []).slice(0, 5).map((j) => ({ title: j.title, company: j.company_name, location: j.candidate_required_location, type: j.job_type, url: j.url })) }) },
  // ---- Government & reference ----
  { id: 'fedregister-docs', name: 'US Federal Register', category: 'Government', host: 'www.federalregister.gov',
    description: 'When to use: the user asks about recent US federal documents or rules on a topic.',
    url: 'https://www.federalregister.gov/api/v1/documents.json?per_page=3&order=newest&conditions%5Bterm%5D={q}',
    params: { q: 'search term, e.g. climate' }, example: { q: 'climate' },
    map: (d) => (need(d.results, 'nothing found')).slice(0, 3).map((x) => ({ title: trunc(x.title, 200), type: x.type, published: x.publication_date, abstract: trunc(x.abstract, 250) })) },
  { id: 'wikipedia-summary', name: 'Wikipedia summary', category: 'Reference', host: 'en.wikipedia.org',
    description: 'When to use: the user asks for background on a topic, person or place (lead section of Wikipedia).',
    url: 'https://en.wikipedia.org/api/rest_v1/page/summary/{title}',
    params: { title: 'article title with underscores, e.g. Albert_Einstein' }, example: { title: 'Albert_Einstein' },
    map: (d) => ({ title: d.title, about: d.description, summary: trunc(d.extract, 500), url: d.content_urls?.desktop?.page }) },
  { id: 'wikipedia-search', name: 'Wikipedia search', category: 'Reference', host: 'en.wikipedia.org',
    description: 'When to use: find Wikipedia article titles matching a query.',
    url: 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={q}&format=json&srlimit=5',
    params: { q: 'search terms, e.g. black holes' }, example: { q: 'black holes' },
    map: (d) => d.query.search.slice(0, 5).map((s) => ({ title: s.title, snippet: trunc(stripTags(s.snippet), 200) })) },
  { id: 'wayback-available', name: 'Archived page lookup', category: 'Reference', host: 'archive.org',
    description: 'When to use: the user asks for an archived copy of a web page (Wayback Machine closest snapshot).',
    url: 'https://archive.org/wayback/available?url={url}',
    params: { url: 'page URL, e.g. example.com' }, example: { url: 'example.com' },
    map: (d) => { const c = d.archived_snapshots?.closest; return c ? { url: c.url, timestamp: c.timestamp, status: c.status } : { available: false }; } },
  { id: 'radio-search', name: 'Radio stations', category: 'Music', host: 'de1.api.radio-browser.info',
    description: 'When to use: the user looks for internet radio stations by name or genre.',
    url: 'https://de1.api.radio-browser.info/json/stations/search?name={q}&hidebroken=true&limit=5',
    params: { q: 'name or genre, e.g. jazz' }, example: { q: 'jazz' },
    map: (d) => d.slice(0, 5).map((s) => ({ name: s.name, country: s.country, codec: s.codec, bitrate: s.bitrate, stream: s.url_resolved })) },
  { id: 'poetrydb-random', name: 'Random poem', category: 'Books', host: 'poetrydb.org',
    description: 'When to use: the user wants a random poem (first lines included).',
    url: 'https://poetrydb.org/random',
    params: {}, example: {},
    map: (d) => { const p = d[0]; return { title: p.title, author: p.author, opening: (p.lines || []).slice(0, 8).join('\n') }; } },
  { id: 'dummyjson-quotes', name: 'Famous quote', category: 'Fun', host: 'dummyjson.com',
    description: 'When to use: the user wants a random famous quote.',
    url: 'https://dummyjson.com/quotes/random',
    params: {}, example: {},
    map: (d) => ({ quote: d.quote, author: d.author }) },
  { id: 'bible-verse', name: 'Bible verse', category: 'Reference', host: 'bible-api.com',
    description: 'When to use: the user asks for a Bible passage (reference like john 3:16).',
    url: 'https://bible-api.com/{ref}',
    params: { ref: 'reference, e.g. john 3:16' }, example: { ref: 'john 3:16' },
    map: (d) => { if (d.error) throw new Error(d.error); return { reference: d.reference, text: trunc(d.text, 500), translation: d.translation_name }; } },
  // ---- Security ----
  { id: 'nvd-cves', name: 'CVE lookup', category: 'Security', host: 'services.nvd.nist.gov',
    description: 'When to use: the user asks about known vulnerabilities (CVEs) for software like openssl or wordpress.',
    url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch={q}&resultsPerPage=3',
    params: { q: 'keyword, e.g. openssl' }, example: { q: 'openssl' },
    map: (d) => (need(d.vulnerabilities, 'no CVEs found')).slice(0, 3).map((v) => { const c = v.cve;
      const m31 = c.metrics?.cvssMetricV31?.[0]?.cvssData, m30 = c.metrics?.cvssMetricV30?.[0]?.cvssData, m2 = c.metrics?.cvssMetricV2?.[0]?.cvssData;
      return { id: c.id, published: c.published, severity: m31?.baseSeverity || m30?.baseSeverity || m2?.baseSeverity, score: m31?.baseScore || m30?.baseScore || m2?.baseScore, about: trunc((c.descriptions || []).find((x) => x.lang === 'en')?.value, 250) }; }) },
  // ---- Sports ----
  { id: 'openligadb-matches', name: 'Football results', category: 'Sports', host: 'api.openligadb.de',
    description: 'When to use: the user asks for recent football scores. League bl1 is the German Bundesliga (also bl2, bl3).',
    url: 'https://api.openligadb.de/getmatchdata/{league}',
    params: { league: 'league shortcut, e.g. bl1' }, example: { league: 'bl1' },
    map: (d) => (need(d, 'no matches')).slice(-5).map((m) => ({ match: `${m.team1?.teamName} vs ${m.team2?.teamName}`, score: m.matchResults?.find((r) => r.resultName === 'Endergebnis') ? `${m.matchResults.find((r) => r.resultName === 'Endergebnis').pointsTeam1}:${m.matchResults.find((r) => r.resultName === 'Endergebnis').pointsTeam2}` : 'upcoming', date: m.matchDateTime, finished: m.matchIsFinished })) },
  { id: 'swpc-kindex', name: 'Geomagnetic activity', category: 'Space', host: 'services.swpc.noaa.gov',
    description: 'When to use: the user asks about geomagnetic storms, the Kp index, or aurora chances (NOAA space weather).',
    url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    params: {}, example: {},
    map: (d) => { const last = d[d.length - 1]; return { time: last.time_tag, kp: last.Kp, note: last.Kp >= 5 ? 'geomagnetic storm in progress' : 'quiet to unsettled' }; } },
  { id: 'nager-countryinfo', name: 'Country borders', category: 'Countries', host: 'date.nager.at',
    description: 'When to use: the user asks what countries border a country, or its region. Country is a 2-letter code.',
    url: 'https://date.nager.at/api/v3/countryinfo/{code}',
    params: { code: '2-letter country code, e.g. DE' }, example: { code: 'DE' },
    map: (d) => ({ name: d.commonName, official: d.officialName, region: d.region, borders: (d.borders || []).map((b) => b.commonName) }) },
  { id: 'asteroid-info', name: 'Asteroid facts', category: 'Space', host: 'ssd-api.jpl.nasa.gov',
    description: 'When to use: the user asks about an asteroid or comet (diameter, orbit, close approaches). Name like Eros or Halley.',
    url: 'https://ssd-api.jpl.nasa.gov/sbdb.api?sstr={name}',
    params: { name: 'asteroid/comet name, e.g. Eros' }, example: { name: 'Eros' },
    map: (d) => ({ name: d.object?.fullname, class: d.object?.orbit_class?.name, near_earth: d.object?.neo, hazardous: d.object?.pha, first_observed: d.orbit?.first_obs, last_observed: d.orbit?.last_obs, observations_used: d.orbit?.n_obs_used }) },
];

// Build the request URL for an entry from caller params (falls back to examples).
// Only declared params are substituted. Each value is encoded per path segment
// (slashes survive, so ids like octocat/Hello-World keep working) and the
// result must stay on the entry's host over HTTPS (checked again server-side).
function buildUrl(entry, params = {}) {
  let u = entry.url;
  for (const k of Object.keys(entry.params)) {
    const v = params[k] ?? entry.example[k] ?? '';
    u = u.split('{' + k + '}').join(String(v).split('/').map(encodeURIComponent).join('/'));
  }
  if (/[{]/.test(u)) throw new Error('unfilled params for ' + entry.id);
  return checkUrl(entry, u);
}
function checkUrl(entry, u) {
  const x = new URL(u);
  if (x.protocol !== 'https:') throw new Error('not https for ' + entry.id);
  if (x.host !== entry.host) throw new Error('host mismatch for ' + entry.id);
  return x.toString();
}
const find = (id) => APIS.find((e) => e.id === id);

// Fetch + map one entry. Never throws: failures become {ok:false, error}.
// The allowlist (entry host over HTTPS, URL built only from the catalog
// template) is a security boundary: this function must never fetch a
// caller-supplied URL, only URLs produced by buildUrl().
async function executeApi(entry, params = {}, { timeoutMs = 8000, maxBytes = 200 * 1024 } = {}) {
  let url;
  try { url = buildUrl(entry, params); } catch (e) { return { ok: false, error: e.message }; }
  let r;
  try {
    r = await fetch(url, { headers: entry.headers || {}, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : String(e.message).slice(0, 150) }; }
  try {
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (/image|audio|video|octet-stream|pdf|zip|font/.test(ct)) return { ok: false, error: 'unsupported content type ' + ct.split(';')[0] };
    let text = '';
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        if (text.length > maxBytes) { try { reader.cancel(); } catch {} return { ok: false, error: `response over ${Math.round(maxBytes / 1024)}KB` }; }
      }
      text += dec.decode();
    } else { text = await r.text(); if (text.length > maxBytes) return { ok: false, error: 'response too large' }; }
    if (!r.ok) return { ok: false, error: `upstream ${r.status}: ${trunc(text, 150)}` };
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    const mapped = entry.map(data, params);
    if (mapped === undefined || mapped === null || (typeof mapped === 'object' && Object.keys(mapped).length === 0)) return { ok: false, error: 'empty result' };
    return { ok: true, data: mapped };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
}

// OpenAI-compatible function tool definition for one entry.
function toTool(entry) {
  const props = {};
  for (const [k, desc] of Object.entries(entry.params)) props[k] = { type: 'string', description: desc + (entry.example[k] ? ` (example: ${entry.example[k]})` : '') };
  return { type: 'function', function: { name: entry.id, description: entry.description, parameters: { type: 'object', properties: props, required: [] } } };
}
// Public catalog for the UI: metadata only, no fetch logic or secrets.
function publicCatalog() {
  return APIS.map((e) => ({ id: e.id, name: e.name, category: e.category, description: e.description, params: e.params }));
}

module.exports = { APIS, find, buildUrl, checkUrl, executeApi, toTool, publicCatalog };
