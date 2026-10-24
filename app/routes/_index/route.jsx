import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Mobi-Preorder &amp; Back in Stock</h1>
        <p className={styles.text}>
          Take pre-orders and email shoppers when sold-out products return.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Pre-order campaigns</strong>. Schedule launches with limits, a
            countdown and a progress bar.
          </li>
          <li>
            <strong>Back-in-stock waitlist</strong>. Shoppers sign up on sold-out
            products and get one email when stock returns.
          </li>
          <li>
            <strong>Emails from your own Gmail</strong>. Choose a template, colour
            and logo for every email.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}
