// deno-lint-ignore-file no-explicit-any

import Queue from "npm:p-queue@latest";
import _ from "npm:lodash@4.17";
import {
  DOMParser,
  HTMLDocument,
} from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";
import { parse } from "https://deno.land/std@0.182.0/flags/mod.ts";

interface Lobbyist {
  id: string | undefined;
  name: string | undefined;
  address: string | undefined;
  phone: string | undefined;
  email: string | undefined;
  mailingAddress: string | undefined;
  registrationDate: string | undefined;
  ethicsCourseCompletionDate: string | undefined;
  status: string | undefined;
  relationships: LobbyistRelationship[];
}

interface LobbyistRelationship {
  entityName: string | undefined;
  entityId: string | undefined;
  type: string | undefined;
  effectiveDate: string | undefined;
  terminationDate: string | undefined;
}

const args = parse(Deno.args);
const concurrency = 4;
const queue = new Queue({ concurrency });
const lobbyists: Lobbyist[] = [];
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0";
const session = args.session ? +args.session : 2023;

async function scrapeLobbyistsForLetter(letter: string): Promise<Lobbyist> {
  console.log(`Scraping lobbyists for ${letter}`);
  const url =
    `https://cal-access.sos.ca.gov/Lobbying/Lobbyists/list.aspx?letter=${letter}&session=${session}`;
  const response = await fetch(url);
  const html = await response.text();
  const document: HTMLDocument | null = new DOMParser().parseFromString(
    html,
    "text/html",
  );

  const data: Lobbyist[] = [];
  const rows = document?.querySelectorAll("#lobbyists tbody tr");

  rows?.forEach((row, i) => {
    if (i === 0) return;
    const cells = row?.querySelectorAll("td");
    const name = cells[0].innerText;
    const link = cells[0].querySelector("a");
    const href = link.getAttribute("href");
    const id = href.split("id=")[1].split("&")[0];
    data.push({
      id,
      name,
      address: undefined,
      phone: undefined,
      email: undefined,
      mailingAddress: undefined,
      registrationDate: undefined,
      ethicsCourseCompletionDate: undefined,
      status: undefined,
      relationships: [],
    });
  });

  return data;
}

async function scrapeLobbyist(id: string, session: string) {
  console.log(`Scraping lobbyist info for ${id}`);
  const url =
    `https://cal-access.sos.ca.gov/Lobbying/Lobbyists/Detail.aspx?id=${id}&session=${session}`;
  const response = await fetch(url);
  const html = await response.text();
  const document: HTMLDocument | null = new DOMParser().parseFromString(
    html,
    "text/html",
  );

  const lobbyist = {
    address: undefined,
    phone: undefined,
    email: undefined,
    mailingAddress: undefined,
    registrationDate: undefined,
    ethicsCourseCompletionDate: undefined,
    status: undefined,
    relationships: [],
  };

  const tbodies = [...document?.querySelectorAll('tbody')].slice(7)

  const addressTable = tbodies.find(d => d.innerHTML.includes('ADDRESS') && !d.innerHTML.includes('MAILING ADDRESS'))
  if (addressTable) {
    const addressText = addressTable.querySelectorAll('tr')[1].textContent.split('\n\t\t').slice(1)
    lobbyist.address = addressText.slice(0, 2).join('\n')
    addressText.forEach(t => {
      if (t.includes('Phone')) {
        lobbyist.phone = t.replace('Phone: ', '').trim()
      }
      else if (t.includes('Email')) {
        lobbyist.email = t.replace('Email: ', '').trim()
      }
    })
  }

  const mailingAddressTable = tbodies.find(d => d.innerHTML.includes('MAILING ADDRESS'))
  lobbyist.mailingAddress = mailingAddressTable ? mailingAddressTable.querySelectorAll('tr')[1].textContent.trim().replaceAll('\t\t', '') : undefined

  const ethicsAndRegistrationTable = tbodies.find(d => d.innerHTML.includes('ETHICS COURSE COMPLETION DATE'))

  if (ethicsAndRegistrationTable) {
    const ethicsCells = ethicsAndRegistrationTable.querySelectorAll('tr')[1].querySelectorAll('td')
    const ethicsCourseCompletionDate = ethicsCells[0].innerText.trim()

    lobbyist.registrationDate = ethicsCells[1].innerText.trim()
    lobbyist.ethicsCourseCompletionDate = ethicsCourseCompletionDate === '' ? undefined : ethicsCourseCompletionDate
    lobbyist.status = ethicsCells[2].innerText.trim()
  }

  const relationshipsTable = tbodies.find(d => d.innerHTML.includes('LOBBYIST RELATIONSHIPS'))
  if (relationshipsTable) {
    const relationshipsRows = relationshipsTable.querySelectorAll('tr')
    relationshipsRows.forEach((r, i) => {
      if (i < 2) return
      const cells = r.querySelectorAll('td')
      const relationship = {
        entityName: cells[0].textContent.trim(),
        entityId: undefined,
        type: cells[1].textContent.trim(),
        effectiveDate: cells[2].textContent.trim(),
        terminationDate: cells[3].textContent.trim(),
      }

      if (relationship.terminationDate === '') {
        relationship.terminationDate = undefined
      }

      lobbyist.relationships.push(relationship)
    })
  }

  return lobbyist;
}

console.log(`Scraping for the ${session}-${session + 1} session`);

letters.split("").forEach((letter) => {
  queue.add(async () => {
    const forLetter: Lobbyist[] = await scrapeLobbyistsForLetter(
      letter,
      session,
    );
    lobbyists.push(...forLetter);
  });
});

await queue.onIdle();

if (lobbyists.length === 0) {
  console.log(
    "Found zero lobbyists - something messed up and not going to save anything",
  );
  Deno.exit(0);
}

lobbyists.forEach((lobbyist) => {
  queue.add(async () => {
    try {
      const scraped = await scrapeLobbyist(lobbyist.id, session);
      Object.assign(lobbyist, scraped);
    } catch (e) {
      console.error(`Error scraping info for ${lobbyist.id}`, e);
    }
  });
});

await queue.onIdle();

console.log(`Sorting`);
const sorted = _.orderBy(lobbyists, ["name", "id"]);
const fileName = `lobbyists-${session}.json`;
console.log(`Saving to ${fileName}`);
await Deno.writeTextFile(`./${fileName}`, JSON.stringify(sorted, null, 2));
console.log(`All done`);
