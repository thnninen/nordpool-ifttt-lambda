import {nordpool} from 'nordpool';
//import request from 'request';
import https from 'https';
import URL from 'url';
//import {config} from './config.cjs';
//import pkg from './config.cjs';
//const {config} = pkg;

//import  pkg from 'aws-sdk';
//const {AWS} =pkg;
//const docClient = new pkg.DynamoDB.DocumentClient();

import { DynamoDBClient, PutItemCommand, GetItemCommand} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const client = new DynamoDBClient({ region: process.env.AWS_REGION});

const config = {
  area: process.env.area ? process.env.area : 'FI', // see http://www.nordpoolspot.com/maps/
  currency: process.env.currency ? process.env.currency : 'EUR', // can also be 'DKK', 'NOK', 'SEK'
  currencySubUnit: process.env.currencySubUnit ? process.env.currencySubUnit : 'snt', // 1/100 of currency, used to format the message passed to IFTTT, can be 'cents', 'öre', 'øre', ...
  highTreshold: process.env.highTreshold ? parseInt(process.env.highTreshold) : 15, // send event when price > highTreshold
  lowTreshold: process.env.lowTreshold ? parseInt(process.env.lowTreshold) : 5, // send event when price < lowTreshold
  maxOnHours: process.env.maxOnHours ? parseInt(process.env.maxOnHours) : 8, // max daily on hours
  defOnHours: process.env.defOnHours ? parseInt(process.env.defOnHours) : 6, // default daily on hours
  minOnHours: process.env.minOnHours ? parseInt(process.env.minOnHours) : 4, // min daily on hours
  vatPercent: process.env.vatPercent ? parseInt(process.env.vatPercent) : 24, // if you want prices including value-added tax (VAT), enter the percentage here
  iftttKey: process.env.iftttKey ? process.env.iftttKey : 'CHANGE!', // see https: process.env.https ? process.env.https ://ifttt.com/services/maker_webhooks/settings
  debugLevel: process.env.debugLevel ? parseInt(process.env.debugLevel) : 2
};


async function createItem(time,on){
  let expD = new Date(time);
  expD.setUTCDate(expD.getUTCDate() + 1);
  let expiry = Math.floor(expD.getTime()/1000.0);

  const params = {
    TableName : 'nordpool-ifttt-events',
    /* Item properties will depend on your application concerns */
    Item: marshall({
       "time": time,
       "on": on,
       "expiry": expiry
    })
  };
  if (config.debugLevel > 1) console.log(params);
  try {
    const command = new PutItemCommand(params);
    const r = await client.send(command);

    //await docClient.put(params).promise();
  } catch (err) {
    console.log(err);
    return err;
  }
};

async function fetch (time) {
  if (config.debugLevel > 1) console.log(time);
  const fparams = {
    TableName : 'nordpool-ifttt-events',
    Key: marshall({
      "time": time
    }),
  };
  if (config.debugLevel > 1) console.log(fparams);

  var resu;
  try {
      resu = await client.send(new GetItemCommand(fparams));
      if (config.debugLevel > 1) console.log(resu);
  } catch(err) {
      console.log(err);
  }
  let item=unmarshall(resu.Item);
  if (config.debugLevel > 1) console.log(item);
  await trigger(item);

  if (config.debugLevel > 1) console.log("here");

};

async function handle_hour () {
  const d = new Date();

  const nd = new Date(d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()+' '+d.getHours()+':00:00');
  let text = nd.toISOString();
  await fetch(text);

};

async function request(url, data) {
    return new Promise((resolve, reject) => {
        let req = https.request(URL.parse(url))
        req.write(data)
        req.end(null, null, () => {
            /* Request has been fully sent */
            resolve(req)
        })
    })
}

async function trigger(item) {
  const onEvent = process.env.onEvent ? process.env.onEvent : 'nordpool_on';
  const offEvent = process.env.offEvent ? process.env.offEvent : 'nordpool_off';
  const iftttUrl = process.env.iftttUrl ? process.env.iftttUrl : 'https://maker.ifttt.com/trigger/';

  let values = {
//    value1: item.value.toFixed(3),
//    value2: config.currencySubUnit + '/kWh',
    value1: item.time
  };
  if(item.on)
    item.event=onEvent;
  else {
    item.event=offEvent;
  }
  var opts = {
    url: iftttUrl + item.event + '/with/key/' + config.iftttKey,
    json: true,
    body: values
  };
  if (config.debugLevel > 1) console.log('Triggering ' + item.event + ' event: ' + JSON.stringify(values) + ' opts: ' + JSON.stringify(opts));
  const resp = await request(opts.url, JSON.stringify(values));
  if (config.debugLevel > 1) console.log('Response '+resp);
/*  await request.post(opts, function(err, res) {
    if (err) {
      console.error(err);
      return;
    }
    console.log('Success: ' + res.body)
  })*/
}



export async function handler (event)  {
  const prices = new nordpool.Prices();
  const lowEvent = 'nordpool_price_low';
  const normEvent = 'nordpool_price_normal';
  const highEvent = 'nordpool_price_high';


  if(event.key1 == 'fetch')
  {
    await handle_hour();
    var resp = {
        statusCode: 200,
        body: JSON.stringify("response"),
    };
    return resp;
  }

  //let myTZ = moment.tz.guess();
  let jobs = [];
  const date = new Date('tomorrow');
  if (config.debugLevel > 1) console.log(`Config:\n${JSON.stringify(config, null, 1)}`);

  // get latest prices immediately
  //getPrices('today');
  const opts = {
    area: config.area,
    currency: config.currency,
    date: date
  };
  if (config.debugLevel > 3) console.log(`opts:\n${JSON.stringify(opts, null, 1)}`);



  const results = await prices.hourly(opts);

    let events = [];
    let tmpHours = [];
    let previousEvent = normEvent;
    var priceMap = new Map();
    var hourMap = new Map();
    results.forEach((item, index) => {
      //item.date = moment(item.date).tz(myTZ);
      if (config.vatPercent) {
          item.value = item.value * (100 + config.vatPercent) / 100;
      }
      item.value = Math.round(item.value * 100)/1000; // Eur/MWh to cents/kWh
      if (item.value > config.highTreshold) {
        if (config.debugLevel > 1) console.log(`${item.date}: ${item.value} > ${config.highTreshold}`);
        item.event = highEvent;
      }
      else if (item.value < config.lowTreshold) {
        if (config.debugLevel > 1) console.log(`${item.date}: ${item.value} < ${config.lowTreshold}`);
        item.event = lowEvent;
      }
      else {
        if (config.debugLevel > 1) console.log(`${item.date}: ${config.lowTreshold} < ${item.value} < ${config.highTreshold}`);
        item.event = normEvent;
      }
      // treshold crossed; let's see what we have stored...
      if (item.event != previousEvent) {
        if (config.debugLevel > 1) console.log(`${item.date}: ${previousEvent} -> ${item.event}`);
      }
      priceMap.set(item.value,item);
      hourMap.set(item.date,false);
    });

    var mapAsc = new Map([...priceMap.entries()].sort((e1, e2) => e1[0] - e2[0]));
    if (config.debugLevel > 1) console.log(mapAsc);
    if (config.debugLevel > 1) console.log(hourMap);

    var iterator_obj=mapAsc.entries();
    var index=0;
    let price_obj=iterator_obj.next();
    while(!price_obj.done)
      {
        if (config.debugLevel > 1) console.log(price_obj.value);
        hourMap.set(price_obj.value[1].date,true);
        price_obj=iterator_obj.next();
        index=index+1;
        if(index >= config.minOnHours && price_obj.value[0] > config.highTreshold )
          {
            break;
          }
        if(index >= config.defOnHours && price_obj.value[0] > config.lowTreshold )
          {
            break;
          }
        if(index >= config.maxOnHours )
          {
            break;
          }
      }
    if (config.debugLevel > 1) console.log(hourMap);
    // TODO implement
    var it_obj=hourMap.entries();
    let hour_obj=it_obj.next();
    while(!hour_obj.done) {
      if (config.debugLevel > 1) console.log(hour_obj.value);
      console.log(await createItem(hour_obj.value[0],hour_obj.value[1]));
      hour_obj=it_obj.next();
    }

    var response = {
        statusCode: 200,
        body: JSON.stringify(results,events),
    };
    return response;
};
